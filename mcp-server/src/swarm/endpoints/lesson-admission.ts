/**
 * POST /swarm/lessons — Swarm sub-phase 4j (issue #138).
 *
 * Receiver-side admission pipeline for incoming v1.1 Lesson envelopes:
 *
 *   1. Pre-checks (cheap, before signature work):
 *        - body shape, origin_node_id present
 *        - self-loop guard (origin_node_id != our own node_id)
 *        - peer-known guard (we hold a pubkey for the origin)
 *        - quarantine guard (origin not currently quarantined)
 *   2. Wire validation: rules 1-13 + 16/19/20 from SWARM_SPEC §5 via
 *      validateWireRecord (the same canonical-bytes verifier the rest of
 *      the swarm uses).
 *   3. Side-effects (only after validation passes):
 *        - INSERT into swarm_lessons with lesson_tier='B' (§10.6 firebreak default)
 *        - +0.05 trust-edge bump for `origin_node_id` (§10.1 'admitted')
 *        - run §10.3 LessonContradictionGate against existing priors
 *
 * Error mapping (issue #138 acceptance):
 *   - 400 plain — non-quarantine validator failures (rules 2/3/4/7/8/9/11/12/13).
 *   - 400 + quarantine — single-strike PoK rules 16 + 20 (§5/§10.2).
 *   - 401 + quarantine — bad signature (rule 5).
 *   - 401 + quarantine — broken commitment chain (rule 19).
 *   - 401 plain — unknown peer (no pubkey held; nothing to quarantine).
 *   - 403 — origin currently quarantined (cheap pre-check, before signature).
 *   - 503 — dependency threw (DB, signature lookup) — operator-readable detail.
 *
 * Substrate split (issue #138 — first slice):
 *   - This module is a pure handler that takes injected callbacks for every
 *     side effect. No HTTP host, no PostgREST, no Supabase client. The
 *     follow-up wiring PR mounts it onto dashboard-server.mjs (mirror of the
 *     #128 → #152 split that worked for the proof endpoint).
 *   - Tests in `lesson-admission.test.ts` exercise every branch with a real
 *     Ed25519 signer (via signWithSelfKey + freshIdentity) and in-memory
 *     deps; no DB and no HTTP server are needed because the handler returns
 *     an HttpResponseShape triple that any host can serialize verbatim.
 */
import { validateWireRecord, type ValidationResult } from "../../services/wire-validator.js";
import type { ContradictionFinding, SwarmLessonRow } from "../../services/lesson-contradiction-gate.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface HttpResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Self-row from `nodes` (`is_self = true`). Only `node_id` is consulted —
 * the self-loop guard refuses to admit a record whose origin claims to be
 * us. Match the proof-endpoint shape so deps line up cleanly.
 */
export interface SelfNode {
  node_id: string;
  pubkey_b64: string;
}

export interface LessonAdmissionDeps {
  /** Already-parsed JSON body. The HTTP host owns the JSON.parse step. */
  body: unknown;

  /** Spec major to negotiate against (1 in v1.x). */
  ourSpecMajor: number;

  /** Injected clock — tests pass a fixed Date. */
  now: Date;

  /** Self-row from `nodes`. Used for the self-loop guard. */
  loadSelf: () => Promise<SelfNode | null>;

  /**
   * Lookup the producer's raw 32-byte Ed25519 pubkey. Returning null
   * collapses to a 401 unknown-peer rejection (no quarantine — we have
   * no edge to write to).
   */
  getPubkeyForNode: (nodeId: string) => Promise<Uint8Array | null>;

  /**
   * Returns the current `quarantined_until` for the node as an ISO-8601
   * string, or null if the node is not quarantined. Used as a cheap
   * pre-check before any signature work.
   */
  getQuarantinedUntil: (nodeId: string) => Promise<string | null>;

  /**
   * Optional. Returns the multihash this receiver expects to see in
   * `prev_lesson_hash` for the next Lesson from `originId`, or null when
   * the receiver holds no prior lesson from this origin (fresh-peer case
   * — rule 19 cannot fire). Forwarded verbatim into validateWireRecord.
   */
  getExpectedPrevLessonHash?: (nodeId: string) => Promise<string | null>;

  /**
   * INSERT the validated lesson into `swarm_lessons` with
   * `lesson_tier='B'` and return the canonical lesson_id. Throws on DB
   * error — handler maps to 503.
   */
  insertSwarmLesson: (lesson: AdmittedLesson) => Promise<{ lesson_id: string }>;

  /**
   * Set `nodes.quarantined_until = untilMs` (single-strike per §5/§10.2).
   * Best-effort — handler does not abort the rejection if this throws.
   */
  setQuarantine: (nodeId: string, untilMs: number, reason: string) => Promise<void>;

  /**
   * Append `{node_id, delta, reason}` to `trust_edge_log` (§10.1).
   * Best-effort — handler still returns 201 on bookkeeping failure
   * because the lesson is already persisted at that point.
   */
  recordTrustEdgeChange: (nodeId: string, delta: number, reason: string) => Promise<void>;

  /**
   * Run §10.3 contradiction gate against this node's existing swarm_lessons.
   * Optional — if omitted, admission still succeeds and the gate is left
   * to a separate batch path. Forwarded findings go in the 201 body so
   * the caller can correlate.
   */
  runContradictionGate?: (incoming: SwarmLessonRow) => Promise<{ findings: ContradictionFinding[] }>;
}

/**
 * Shape of the row we hand to `insertSwarmLesson` after rules 1-20
 * have all returned ok. The wiring layer can pass this straight to a
 * PostgREST insert — column names match `swarm_lessons` (migration 071
 * + 074 + 077 + 078). `lesson_tier` is fixed to 'B' because §10.6
 * mandates the firebreak default for any externally-admitted lesson.
 */
export interface AdmittedLesson {
  id: string;
  content: string;
  embedding: number[];
  synthesized_from_cluster_size: number;
  origin_node_id: string;
  signed_at: string;
  signature: string;
  created_at: string;
  spec_version: string;
  tags?: string[];
  // v1.1 PoK fields — required because validateWireRecord enforces
  // their presence on spec_version >= 1.1, and v1.0 is a write
  // configuration that #138 declines to support (the receiver pipeline
  // is v1.1-only).
  evidence_root: string;
  evidence_count: number;
  prev_lesson_hash: string | null;
  maturity_age_days: number;
  useful_count: number;
  /** Receiver-pinned tier — always 'B' per §10.6 admission firebreak. */
  lesson_tier: "B";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

const ONE_HOUR_MS = 60 * 60 * 1000;

// Rules whose rejection pulls the producer into a 1-hour quarantine. The set
// is the union of §5 rule 5 (signature failure), rule 19 (broken chain), and
// rules 16/20 (PoK shape — single-strike per §10.2). Any other rejection is a
// 400/401 plain — a malformed v1.0 record from a legitimate peer should not
// burn an hour of admission for the rest of the batch.
const SINGLE_STRIKE_RULES: ReadonlySet<number> = new Set([5, 16, 19, 20]);

// UUID v1-v8, lowercase or uppercase. Used to sanity-check `id` before it
// becomes the canonical lesson_id of the admitted row. The full validator
// catches malformed strings via rule 3 (typeof string), but a UUID-shape
// check here keeps the failure mode at "400 bad-id" rather than "500
// constraint violation" if someone slips an arbitrary string past the
// type guard upstream.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function admitSwarmLesson(
  deps: LessonAdmissionDeps,
): Promise<HttpResponseShape> {
  // 1. Body must be a JSON object.
  if (deps.body === null || typeof deps.body !== "object" || Array.isArray(deps.body)) {
    return jsonResponse(400, { error: "body must be a JSON object" });
  }
  const record = deps.body as Record<string, unknown>;

  // 2. origin_node_id must at least be a non-empty string before we can
  //    route quarantine logic. This is also rule 2 territory in the
  //    validator, but we need the origin string before the validator call
  //    in order to do the cheap quarantine pre-check.
  const originId = record.origin_node_id;
  if (typeof originId !== "string" || originId.length === 0) {
    return jsonResponse(400, {
      error: "origin_node_id is required and must be a non-empty string",
      rule: 2,
    });
  }

  // id presence + UUID shape — validator's rule 3 will also catch type
  // mismatches, but admitting a row whose `id` will later violate
  // `swarm_lessons.id` PRIMARY KEY would surface as 503 from the DB; we
  // keep that as a 400 here.
  const lessonId = record.id;
  if (typeof lessonId !== "string" || !UUID_RE.test(lessonId)) {
    return jsonResponse(400, {
      error: "id must be a UUID",
      rule: 3,
    });
  }

  // 3. Self-loop guard. We refuse to admit a row whose origin claims to
  //    be us — that path lets a peer overwrite our own lesson chain
  //    with arbitrary content. Self-published lessons go through the
  //    producer path, never the admission endpoint.
  let self: SelfNode | null;
  try {
    self = await deps.loadSelf();
  } catch (e) {
    return jsonResponse(503, {
      error: "loadSelf failed",
      detail: detailOf(e),
    });
  }
  if (!self) {
    return jsonResponse(503, {
      error:
        "node identity not initialized; run scripts/init-node-identity.mjs first",
    });
  }
  if (originId === self.node_id) {
    return jsonResponse(400, {
      error: "admission of self-published lesson refused (use producer path)",
      origin_node_id: originId,
    });
  }

  // 4. Peer-known guard. The validator collapses unknown-peer to rule 5
  //    (signature failure) because it has no pubkey to verify against,
  //    but we want to distinguish "we know this peer and they sent a bad
  //    signature" (single-strike quarantine) from "we don't know who
  //    this is" (no-edge, plain 401).
  let pubkey: Uint8Array | null;
  try {
    pubkey = await deps.getPubkeyForNode(originId);
  } catch (e) {
    return jsonResponse(503, {
      error: "getPubkeyForNode failed",
      detail: detailOf(e),
      origin_node_id: originId,
    });
  }
  if (!pubkey) {
    return jsonResponse(401, {
      error: "unknown peer; pubkey not held for origin_node_id",
      origin_node_id: originId,
    });
  }

  // 5. Quarantine pre-check. Cheaper than a signature verify and avoids
  //    burning admission budget on a peer we've already firebreaked.
  let quarantinedUntil: string | null;
  try {
    quarantinedUntil = await deps.getQuarantinedUntil(originId);
  } catch (e) {
    return jsonResponse(503, {
      error: "getQuarantinedUntil failed",
      detail: detailOf(e),
      origin_node_id: originId,
    });
  }
  if (quarantinedUntil) {
    const untilMs = Date.parse(quarantinedUntil);
    if (Number.isFinite(untilMs) && untilMs > deps.now.getTime()) {
      return jsonResponse(403, {
        error: "origin is currently quarantined",
        origin_node_id: originId,
        quarantined_until: quarantinedUntil,
      });
    }
  }

  // 6. Pre-resolve the expected prev-lesson hash, if a lookup was supplied.
  //    validateWireRecord's `getExpectedPrevLessonHashForOrigin` is sync
  //    (returns `string | null`), but our injected dep is async — so we
  //    fetch once here and hand the resolved value into the validator
  //    via a sync closure. Same trade-off the rest of the swarm services
  //    take when crossing the sync-validator / async-IO boundary.
  let expectedPrevHash: string | null = null;
  if (deps.getExpectedPrevLessonHash) {
    try {
      expectedPrevHash = (await deps.getExpectedPrevLessonHash(originId)) ?? null;
    } catch (e) {
      return jsonResponse(503, {
        error: "getExpectedPrevLessonHash failed",
        detail: detailOf(e),
        origin_node_id: originId,
      });
    }
  }

  // Wire validation. validateWireRecord is the canonical §5 check — we
  // don't re-implement any rule here, only map the result into our HTTP
  // shape. The pubkey lookup is constrained to the origin we already
  // resolved above, so a record whose internal origin field differs
  // from the path-level origin (none here, but defensive) cannot smuggle
  // a different verifier key.
  let validation: ValidationResult;
  try {
    validation = await validateWireRecord(deps.body, "lesson", {
      ourSpecMajor: deps.ourSpecMajor,
      now: deps.now,
      getPubkeyForNode: (id) => (id === originId ? pubkey : null),
      getExpectedPrevLessonHashForOrigin: deps.getExpectedPrevLessonHash
        ? () => expectedPrevHash
        : undefined,
    });
  } catch (e) {
    return jsonResponse(503, {
      error: "wire validation threw",
      detail: detailOf(e),
    });
  }

  if (!validation.ok) {
    const status =
      validation.rule === 5 || validation.rule === 19 ? 401 : 400;
    const quarantine = SINGLE_STRIKE_RULES.has(validation.rule);
    if (quarantine) {
      try {
        await deps.setQuarantine(
          originId,
          deps.now.getTime() + ONE_HOUR_MS,
          `wire-rule-${validation.rule}`,
        );
      } catch (e) {
        // Quarantine bookkeeping failure is non-fatal — the rejection
        // still returns to the caller; an unquarantined-but-rejected
        // peer is recoverable, a missed rejection is not.
        console.error(
          `[lesson-admission] setQuarantine failed for ${originId}: ${detailOf(e)}`,
        );
      }
    }
    return jsonResponse(status, {
      error: "wire validation rejected record",
      rule: validation.rule,
      reason: validation.reason,
      origin_node_id: originId,
      quarantined: quarantine,
    });
  }

  // 7. Build the row to insert. By this point validation has guaranteed
  //    every field below is present and the right type, so the cast is
  //    safe. lesson_tier is hard-pinned to 'B' (§10.6 firebreak).
  const lessonRow: AdmittedLesson = {
    id: record.id as string,
    content: record.content as string,
    embedding: record.embedding as number[],
    synthesized_from_cluster_size: record.synthesized_from_cluster_size as number,
    origin_node_id: originId,
    signed_at: record.signed_at as string,
    signature: record.signature as string,
    created_at: record.created_at as string,
    spec_version: record.spec_version as string,
    tags: Array.isArray(record.tags) ? (record.tags as string[]) : undefined,
    evidence_root: record.evidence_root as string,
    evidence_count: record.evidence_count as number,
    prev_lesson_hash: (record.prev_lesson_hash as string | null) ?? null,
    maturity_age_days: record.maturity_age_days as number,
    useful_count: record.useful_count as number,
    lesson_tier: "B",
  };

  // 8. INSERT. Failure here is the one place we abort hard — the lesson
  //    is otherwise valid and the receiver pipeline cannot proceed
  //    without it being persisted (the gate, the trust-edge update, and
  //    a future REM self-audit all key off swarm_lessons.id).
  let insertResult: { lesson_id: string };
  try {
    insertResult = await deps.insertSwarmLesson(lessonRow);
  } catch (e) {
    return jsonResponse(503, {
      error: "insertSwarmLesson failed",
      detail: detailOf(e),
      origin_node_id: originId,
    });
  }

  // 9. Trust edge: §10.1 "+0.05 admitted". Best-effort — the lesson is
  //    already persisted; a dropped trust update degrades reputation
  //    accuracy, not correctness.
  try {
    await deps.recordTrustEdgeChange(originId, 0.05, "admitted");
  } catch (e) {
    console.error(
      `[lesson-admission] recordTrustEdgeChange failed for ${originId}: ${detailOf(e)}`,
    );
  }

  // 10. §10.3 contradiction gate. Best-effort — gate findings demote
  //     both sides to Tier-B (already our default) and append edges to
  //     swarm_lesson_contradictions. Failure here means a pair we should
  //     have flagged stays unflagged; REM self-audit (§10.5) is the
  //     fallback discovery path.
  let gateFindings: ContradictionFinding[] = [];
  if (deps.runContradictionGate) {
    try {
      const gate = await deps.runContradictionGate({
        id: insertResult.lesson_id,
        content: lessonRow.content,
        embedding: lessonRow.embedding,
        lesson_tier: "B",
      });
      gateFindings = gate.findings;
    } catch (e) {
      console.error(
        `[lesson-admission] runContradictionGate failed for ${insertResult.lesson_id}: ${detailOf(e)}`,
      );
    }
  }

  return {
    status: 201,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify({
      lesson_id: insertResult.lesson_id,
      lesson_tier: "B",
      contradictions: gateFindings.length,
      origin_node_id: originId,
    }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): HttpResponseShape {
  return {
    status,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(body),
  };
}

function detailOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
