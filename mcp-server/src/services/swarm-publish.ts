/**
 * Swarm publish-tier-A service — Phase 4 / issue #143 write-side slice.
 *
 * Forces a locally-generated lesson into the broadcast-eligible Tier-A
 * state: signs it with the node's self-key, computes the §3.7.2 chain
 * hash, and dispatches to the migration-087 RPC
 * `operator_publish_tier_a_lesson(...)` for the atomic lesson_chain +
 * swarm_lessons + tier_promotion_log + UPDATE-to-A apply.
 *
 * Why the TS layer has to participate at all (vs a pure SQL RPC):
 *
 *   - The Ed25519 private key MUST stay in the chmod-0600 file outside the
 *     database (Verfassung pillar 1: sovereignty). Postgres has no way to
 *     read it. So signing happens in TS via signWithSelfKey, and the
 *     resulting signature + signed_at + lesson_hash are passed into the
 *     RPC for atomic apply.
 *
 *   - The chain hash (lesson_hash) commits to the full signed bytes
 *     including the signature itself (SWARM_SPEC §3.7.2). It can only be
 *     computed AFTER signing, so the TS layer owns this hash too.
 *
 *   - The chain tip read (`compute_next_prev_lesson_hash` +
 *     `compute_next_sequence_number`) happens in TS so it can be folded
 *     into the same retry loop as the signing — a sequence_number race
 *     forces a re-sign because the new tip has a different prev_hash.
 *
 * Concurrency contract — sequence_number race:
 *
 *   Two parallel publishers can read the same chain tip and race to
 *   insert the same sequence_number. Migration 074's UNIQUE constraint
 *   catches the loser; the migration-087 RPC re-raises as
 *   `lesson_chain_sequence_number_race`. We retry the WHOLE pipeline
 *   (re-read tip, re-build, re-sign, re-call RPC) up to
 *   MAX_SEQUENCE_RACE_RETRIES times. Same retry budget as
 *   signLessonAndAppendToChain — three is generous; a third concurrent
 *   publisher on a single mycelium indicates misconfiguration.
 *
 * Idempotency contract:
 *
 *   - Already-Tier-A swarm_lessons row → RPC returns
 *     status='already_published'; the service returns the same.
 *   - Already-Tier-B swarm_lessons row for this id → RPC raises (a
 *     self-published lesson at B with this RPC's contract is an
 *     inconsistent state). Service surfaces as a hard error with a
 *     fix_hint pointing the operator at swarm_pin_lesson.
 *
 * Spec invariants enforced before signing (so a bad caller gets a clean
 * error rather than an opaque RPC raise):
 *
 *   - synth_size >= 2 (§3.1 / migration 071 column CHECK)
 *   - content octet-length <= 8192 (§5 rule 12 / migration 071 CHECK)
 *   - embedding length 768 (NodeJS doesn't enforce vector dimension; the
 *     RPC's pgvector cast would fail late, so we cut it short here)
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

import {
  computeLessonHash,
  type UnsignedLesson,
  type SignedLesson,
} from "./lesson-chain.js";
import {
  signWithSelfKey,
  type SignedRecord,
} from "./signature.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The local lesson row this service publishes. A subset of the columns on
 * `lessons` (migration 015) — only the fields the swarm Lesson envelope
 * needs. The service loader produces this; tests construct it directly.
 */
export interface LocalLessonRow {
  id: string;
  content: string;
  embedding: number[];
  evidence_count: number;
  created_at: string;
  tags?: string[] | null;
}

/**
 * The chain tip read from `compute_next_prev_lesson_hash` +
 * `compute_next_sequence_number` (migration 074). Same shape as
 * `ChainTip` in lesson-chain.ts; duplicated here so the publish service's
 * dep bag stays self-contained without re-exporting an internal.
 */
export interface PublishChainTip {
  prev_lesson_hash: string | null;
  sequence_number: number;
}

/**
 * Discriminated outcome returned to the MCP tool layer. The two arms map
 * one-to-one onto the migration-087 RPC's `status` field so the tool can
 * branch on `outcome.status` without re-parsing.
 */
export type PublishTierAOutcome =
  | {
      status: "published";
      lesson_id: string;
      origin_node_id: string;
      lesson_tier: "A";
      sequence_number: number;
      lesson_hash: string;
      audit_reason: string;
      signed_at: string;
      received_at: string;
    }
  | {
      status: "already_published";
      lesson_id: string;
      lesson_tier: "A";
      chain_present: boolean;
    };

/** Per-call options. `note` is appended to the audit reason. */
export interface PublishTierAOptions {
  /** Spec version stamped on the wire. Defaults to "1.1". */
  spec_version?: string;
  /** Human-readable note, appended to `tool-publish:` in tier_promotion_log. */
  note?: string;
}

/**
 * Side-effect bag — every DB write goes through one of these so the
 * orchestrator is testable without a live Supabase. Mirror of
 * `LessonChainDeps` from lesson-chain.ts.
 */
export interface SwarmPublishDeps {
  /**
   * Load the local lesson row for `lessonId`. Returns null when the row
   * does not exist (caller maps to a "lesson not found" error). The
   * service does NOT touch any other column from `lessons` — keep the
   * shape narrow so a future column rename is a one-line change here.
   */
  loadLocalLesson(lessonId: string): Promise<LocalLessonRow | null>;
  /**
   * Resolve `node_id` from `nodes WHERE is_self = TRUE`. Returns null
   * when the node identity has not been bootstrapped (no `is_self` row).
   * The migration-085 trigger would also raise on this case; checking
   * up front gives a cleaner error.
   */
  loadSelfNodeId(): Promise<string | null>;
  /**
   * Read the chain tip — `compute_next_prev_lesson_hash` +
   * `compute_next_sequence_number` (migration 074). The service refuses
   * to sign if the biconditional `seq=0 iff prev=null` is violated.
   */
  readChainTip(): Promise<PublishChainTip>;
  /**
   * Invoke the migration-087 `operator_publish_tier_a_lesson(...)` RPC
   * and return the parsed JSONB body. Throws on RPC failure with the
   * original postgrest message preserved so the orchestrator can
   * pattern-match for the `lesson_chain_sequence_number_race` retry case.
   */
  callOperatorPublishTierA(args: {
    lesson_id: string;
    content: string;
    embedding: number[];
    synth_size: number;
    origin: string;
    signed_at: string;
    created_at: string;
    signature: string;
    tags: string[];
    spec_version: string;
    lesson_hash: string;
    prev_hash: string | null;
    sequence: number;
    audit_note: string | null;
  }): Promise<unknown>;
  /**
   * Sign a record with the node's persistent self-key. Defaults to
   * `signWithSelfKey` (reads `MYCELIUM_NODE_KEY` or
   * `~/.mycelium/node.key`). Tests inject a deterministic signer.
   */
  signRecord?: <T extends object>(record: T) => SignedRecord<T>;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the unit tests can pin them independently.
// ---------------------------------------------------------------------------

/**
 * Default spec version stamped on the wire when the caller does not
 * specify. v1.1 is the current Proof-of-Knowledge spec; v1.0 callers
 * still deserialize correctly per §6.1 minor-bump compat. Bumped here
 * (vs 1.0) because the producer pipeline emits the v1.1 evidence_*
 * fields as soon as they are populated; lessons published via this tool
 * may not have them but the spec_version itself is forward-compatible.
 */
export const DEFAULT_SPEC_VERSION = "1.1";

/** Bounded retry budget on a parallel `sequence_number` race. */
export const MAX_SEQUENCE_RACE_RETRIES = 3;

/**
 * Validate a local lesson row against the wire-spec invariants this
 * service is responsible for catching pre-sign. Throws with a precise
 * error message — the MCP tool wraps the message into a structured
 * `{error, fix_hint}` payload.
 *
 * - synth_size >= 2 — §3.1 / migration 071 column CHECK
 * - content octet length <= 8192 — §5 rule 12 / migration 071 CHECK
 * - embedding length === 768 — pgvector(768) (migration 002 et al.)
 * - content non-empty — defensive: an empty lesson would pass octet
 *   bounds but is meaningless on the wire and §5 rule 13 (content non-
 *   empty) would reject it on the receiver side.
 */
export function assertLocalLessonPublishable(row: LocalLessonRow): void {
  if (!row.id || typeof row.id !== "string") {
    throw new Error("publish: local lesson row missing id");
  }
  if (typeof row.content !== "string" || row.content.trim().length === 0) {
    throw new Error("publish: local lesson content is empty");
  }
  // Buffer.byteLength gives the UTF-8 octet length — same metric the
  // migration-071 CHECK uses (octet_length(content)).
  const octets = Buffer.byteLength(row.content, "utf8");
  if (octets > 8192) {
    throw new Error(
      `publish: local lesson content exceeds 8192 octets (got ${octets})`,
    );
  }
  if (typeof row.evidence_count !== "number" || row.evidence_count < 2) {
    throw new Error(
      `publish: local lesson evidence_count must be >= 2 (got ${row.evidence_count}). The §3.1 cluster floor refuses single-experience lessons on the wire.`,
    );
  }
  if (!Array.isArray(row.embedding) || row.embedding.length !== 768) {
    throw new Error(
      `publish: local lesson embedding must be a 768-dim vector (got ${
        Array.isArray(row.embedding) ? `length ${row.embedding.length}` : typeof row.embedding
      })`,
    );
  }
}

/**
 * Build the `UnsignedLesson` payload for the producer signing step from a
 * loaded local lesson row + the resolved self node_id. Pure — no
 * randomness, no clock reads. The tip's `prev_lesson_hash` is attached
 * later by `signLessonAndAppendToChain` (or, in this service, by the
 * orchestrator just before calling the signer); the unsigned payload
 * here intentionally omits it for the same reason
 * `signLessonAndAppendToChain` does (the chain hook owns prev_hash).
 *
 * The `created_at` field on the wire MUST be the local lesson's
 * created_at — receivers reason about freshness via (now - created_at)
 * and rebroadcasting a stale lesson with a fresh created_at would let
 * a node's audit-window count a re-publish as a fresh observation.
 */
export function buildUnsignedSwarmLesson(
  row: LocalLessonRow,
  selfNodeId: string,
  spec_version: string,
): UnsignedLesson {
  if (!selfNodeId) {
    throw new Error("publish: selfNodeId is required");
  }
  const tags = Array.isArray(row.tags) ? [...row.tags] : [];
  return {
    id: row.id,
    content: row.content,
    embedding: row.embedding,
    synthesized_from_cluster_size: row.evidence_count,
    origin_node_id: selfNodeId,
    created_at: row.created_at,
    spec_version,
    tags,
  };
}

/**
 * Validate the chain tip's first-lesson biconditional (seq=0 iff
 * prev=null) — same pin as `assertChainTipBiconditional` in
 * lesson-chain.ts. Duplicated here on purpose so the publish path raises
 * BEFORE signing (the signature commits to prev_hash; a lying tip would
 * waste a sign call).
 */
export function assertChainTipBiconditional(tip: PublishChainTip): void {
  const isFirst = tip.sequence_number === 0;
  const hasNullPrev = tip.prev_lesson_hash === null;
  if (isFirst !== hasNullPrev) {
    throw new Error(
      `publish: chain tip biconditional violated (seq=${tip.sequence_number}, prev_hash=${
        tip.prev_lesson_hash === null ? "null" : "present"
      }) — must be seq=0 iff prev=null`,
    );
  }
  if (tip.sequence_number < 0) {
    throw new Error(
      `publish: chain tip returned negative sequence_number (${tip.sequence_number})`,
    );
  }
}

/**
 * Map the JSONB body of `operator_publish_tier_a_lesson` onto the typed
 * `PublishTierAOutcome` union. Postgres' jsonb_build_object preserves
 * key names but not types — every value lands on `unknown` and we narrow
 * here. Throws on shape drift so a future migration edit fails loud
 * (same discipline as `parseResolveOutcome` in
 * swarm-resolve-contradict.ts).
 */
export function parsePublishOutcome(raw: unknown): PublishTierAOutcome {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `operator_publish_tier_a_lesson: expected JSONB object, got ${
        Array.isArray(raw) ? "array" : typeof raw
      }`,
    );
  }
  const r = raw as Record<string, unknown>;
  if (r.ok !== true) {
    throw new Error(
      `operator_publish_tier_a_lesson: ok flag missing or not true: ${JSON.stringify(r)}`,
    );
  }
  const status = r.status;
  if (status === "already_published") {
    return {
      status: "already_published",
      lesson_id: requireString(r, "lesson_id"),
      lesson_tier: "A",
      chain_present: Boolean(r.chain_present),
    };
  }
  if (status === "published") {
    return {
      status: "published",
      lesson_id:       requireString(r, "lesson_id"),
      origin_node_id:  requireString(r, "origin_node_id"),
      lesson_tier:     "A",
      sequence_number: requireNumber(r, "sequence_number"),
      lesson_hash:     requireString(r, "lesson_hash"),
      audit_reason:    requireString(r, "audit_reason"),
      signed_at:       requireString(r, "signed_at"),
      received_at:     requireString(r, "received_at"),
    };
  }
  throw new Error(
    `operator_publish_tier_a_lesson: unexpected status ${JSON.stringify(status)}`,
  );
}

function requireString(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  if (typeof v !== "string") {
    throw new Error(
      `operator_publish_tier_a_lesson: ${key} missing or not a string`,
    );
  }
  return v;
}

function requireNumber(r: Record<string, unknown>, key: string): number {
  const v = r[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(
      `operator_publish_tier_a_lesson: ${key} missing or not a finite number`,
    );
  }
  return v;
}

/**
 * Detect the migration-087 sequence_number race signal so the
 * orchestrator can retry. The RPC re-raises with a stable diagnostic
 * prefix; we match on substring for resilience to minor wording
 * changes (and to the fact that postgrest may wrap or truncate the
 * message text on its way through the client).
 */
export function isSequenceNumberRaceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("lesson_chain_sequence_number_race");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class SwarmPublishService {
  private db: SupabaseClient;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.db = createClient(supabaseUrl, supabaseKey);
  }

  /**
   * Publish a local lesson at Tier-A. Returns the parsed outcome union;
   * throws on:
   *   - lesson not found
   *   - validation failure (synth_size, content size, embedding shape)
   *   - node identity not bootstrapped
   *   - chain tip biconditional violation
   *   - RPC error (preserved verbatim for the tool layer's fix_hint mapping)
   *   - exceeded MAX_SEQUENCE_RACE_RETRIES on a parallel publisher race
   */
  async publishTierA(
    lessonId: string,
    options: PublishTierAOptions,
    deps: SwarmPublishDeps,
  ): Promise<PublishTierAOutcome> {
    const local = await deps.loadLocalLesson(lessonId);
    if (local === null) {
      throw new Error(`publish: local lesson ${lessonId} not found`);
    }
    assertLocalLessonPublishable(local);

    const self = await deps.loadSelfNodeId();
    if (!self) {
      throw new Error(
        "publish: node identity not bootstrapped — run scripts/init-node-identity.mjs first",
      );
    }

    const spec_version = options.spec_version ?? DEFAULT_SPEC_VERSION;
    const auditNote = options.note ?? null;
    const signer = deps.signRecord ?? signWithSelfKey;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < MAX_SEQUENCE_RACE_RETRIES; attempt++) {
      const tip = await deps.readChainTip();
      assertChainTipBiconditional(tip);

      const unsigned = buildUnsignedSwarmLesson(local, self, spec_version);
      const withPrev = {
        ...unsigned,
        prev_lesson_hash: tip.prev_lesson_hash,
      };
      const signed = signer(withPrev);
      const fullySigned = {
        ...signed.record,
        signature: signed.signature,
      } as SignedLesson;
      const lesson_hash = computeLessonHash(fullySigned);

      try {
        const raw = await deps.callOperatorPublishTierA({
          lesson_id:    local.id,
          content:      local.content,
          embedding:    local.embedding,
          synth_size:   local.evidence_count,
          origin:       self,
          signed_at:    signed.signed_at,
          created_at:   local.created_at,
          signature:    signed.signature,
          tags:         unsigned.tags ?? [],
          spec_version,
          lesson_hash,
          prev_hash:    tip.prev_lesson_hash,
          sequence:     tip.sequence_number,
          audit_note:   auditNote,
        });
        return parsePublishOutcome(raw);
      } catch (err) {
        if (isSequenceNumberRaceError(err)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw new Error(
      `publish: exceeded ${MAX_SEQUENCE_RACE_RETRIES} sequence_number race retries; last error: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }

  /**
   * Default deps wired against the service's own SupabaseClient. The MCP
   * tool uses this when running in-process; tests inject mocks.
   */
  defaultDeps(): SwarmPublishDeps {
    const db = this.db;
    return {
      async loadLocalLesson(lessonId) {
        const { data, error } = await db
          .from("lessons")
          .select("id, lesson, embedding, evidence_count, created_at")
          .eq("id", lessonId)
          .maybeSingle();
        if (error) {
          throw new Error(
            `publish loadLocalLesson failed: ${error.message ?? String(error)}`,
          );
        }
        if (!data) return null;
        const row = data as {
          id: string;
          lesson: string;
          embedding: number[] | string | null;
          evidence_count: number;
          created_at: string;
        };
        // pgvector returns the embedding as a pg-formatted string ('[…]')
        // by default. Parse it so the orchestrator sees a number[].
        let embedding: number[];
        if (Array.isArray(row.embedding)) {
          embedding = row.embedding;
        } else if (typeof row.embedding === "string") {
          embedding = parseVectorString(row.embedding);
        } else {
          throw new Error(
            `publish loadLocalLesson: lesson ${lessonId} has no embedding`,
          );
        }
        return {
          id:             row.id,
          content:        row.lesson,
          embedding,
          evidence_count: row.evidence_count,
          created_at:     row.created_at,
        };
      },
      async loadSelfNodeId() {
        const { data, error } = await db
          .from("nodes")
          .select("node_id")
          .eq("is_self", true)
          .maybeSingle();
        if (error) {
          throw new Error(
            `publish loadSelfNodeId failed: ${error.message ?? String(error)}`,
          );
        }
        if (!data) return null;
        return (data as { node_id: string }).node_id;
      },
      async readChainTip() {
        const [{ data: prev, error: prevErr }, { data: seq, error: seqErr }] =
          await Promise.all([
            db.rpc("compute_next_prev_lesson_hash"),
            db.rpc("compute_next_sequence_number"),
          ]);
        if (prevErr) {
          throw new Error(
            `publish compute_next_prev_lesson_hash failed: ${prevErr.message}`,
          );
        }
        if (seqErr) {
          throw new Error(
            `publish compute_next_sequence_number failed: ${seqErr.message}`,
          );
        }
        return {
          prev_lesson_hash: (prev as string | null) ?? null,
          sequence_number:  typeof seq === "number" ? seq : Number(seq ?? 0),
        };
      },
      async callOperatorPublishTierA(args) {
        const { data, error } = await db.rpc("operator_publish_tier_a_lesson", {
          p_lesson_id:    args.lesson_id,
          p_content:      args.content,
          p_embedding:    args.embedding,
          p_synth_size:   args.synth_size,
          p_origin:       args.origin,
          p_signed_at:    args.signed_at,
          p_created_at:   args.created_at,
          p_signature:    args.signature,
          p_tags:         args.tags,
          p_spec_version: args.spec_version,
          p_lesson_hash:  args.lesson_hash,
          p_prev_hash:    args.prev_hash,
          p_sequence:     args.sequence,
          p_audit_note:   args.audit_note,
        });
        if (error) {
          throw new Error(error.message ?? String(error));
        }
        return data;
      },
    };
  }
}

/**
 * Parse a pgvector string (`"[1, 2, 3]"`) into a number[]. Defensive
 * against trailing whitespace and the rare `null` embedding (rejected
 * by the loader before reaching here).
 */
function parseVectorString(s: string): number[] {
  const trimmed = s.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`publish: malformed vector string: ${trimmed.slice(0, 32)}…`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(",").map((part) => {
    const n = Number(part.trim());
    if (!Number.isFinite(n)) {
      throw new Error(`publish: malformed vector entry: ${part}`);
    }
    return n;
  });
}
