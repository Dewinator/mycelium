/**
 * Producer-side lesson_chain hook — Swarm sub-phase 4d (issue #136).
 *
 * Wires the substrate from migration 074 (`lesson_chain` table + the
 * `compute_next_prev_lesson_hash` / `compute_next_sequence_number`
 * helper RPCs) into a producer flow that signs a Lesson record for
 * swarm consumption and appends one row to the per-node commitment
 * chain. Without this hook the chain stays at 0 rows on a fully-deployed
 * mycelium and §5 rule 19 (broken commitment chain) has nothing to
 * verify against — the substrate is dead.
 *
 * The two on-the-wire invariants this module is responsible for, both
 * traceable to SWARM_SPEC §3.7.2:
 *
 *   1. `prev_lesson_hash` is INSIDE the canonical bytes that get signed.
 *      A lesson signed without `prev_lesson_hash` baked in does not
 *      commit to the chain — a malicious producer could rewrite history
 *      by re-issuing prior lessons against new prev pointers. The signing
 *      step here builds the unsigned record with `prev_lesson_hash`
 *      already attached, so the field is part of the JCS bytes.
 *
 *   2. `lesson_hash = multihash(sha2-256, JCS(signed_lesson_with_signature))`.
 *      Receivers reconstructing the chain (§3.7.2 paragraph 3) hash the
 *      entire signed Lesson — signature included. This module computes
 *      the same hash here, so the value stored in `lesson_chain.lesson_hash`
 *      matches what every receiver will compute when validating the
 *      chain via `swarm_lessons` order-by-signed_at.
 *
 * Atomicity guarantee (#136 acceptance criterion #4):
 *
 *   The signing step is side-effect-free (in-memory only). The chain
 *   INSERT is the single DB write. If the INSERT fails — including the
 *   UNIQUE-conflict races documented below — the wrapping operation
 *   throws, so the caller MUST treat the lesson as not-published.
 *
 *   Concurrent publishers are serialized by migration 074's UNIQUE
 *   constraints (PRIMARY KEY on `lesson_id`, UNIQUE on `sequence_number`):
 *     - Re-signing the same `lesson_id` is detected up front by the
 *       idempotency check (loadByLessonId) and short-circuits to the
 *       existing row — no second chain row, ever.
 *     - Two parallel writers reading the same chain tip race to INSERT;
 *       the loser hits UNIQUE(sequence_number) and the orchestrator
 *       retries the read-build-sign-insert loop. Bounded retry count so
 *       a pathological loop fails loudly rather than spinning.
 *
 * Scope discipline (#136 Out of scope):
 *
 *   - Receiver-side rule-19 enforcement (already in `wire-validator.ts`
 *     via PR #119) is NOT touched.
 *   - Outbound broadcasting of Tier-A lessons (#139) is NOT wired here;
 *     this module provides the helper that #139 will call, plus the
 *     default Supabase-backed deps factory so the integration is a
 *     one-liner. The acceptance criteria are exercised end-to-end by
 *     the unit tests against an in-memory dep stub — same pattern the
 *     surrounding 4i/4h orchestrators use.
 *   - Cross-node chain reconciliation (Phase 5) is NOT touched.
 */
import { createHash } from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";

import {
  signWithSelfKey,
  canonicalize,
  type SignedRecord,
} from "./signature.js";
import { base58btcEncode } from "./node-identity.js";

// ---------------------------------------------------------------------------
// multihash(sha2-256, …) — same encoding the rest of the swarm uses.
//
// Duplicated from evidence-merkle.ts on purpose: that module's helper is
// a `__internal` test-export, not a public surface, and re-exporting it
// would couple a Phase-4c file to Phase-4d for purely presentational
// reasons. The multihash header constants below are 4 bytes of fixed
// IANA-registered identifiers — collapsing them into a shared module
// would only save those 4 bytes while widening the import graph.
// ---------------------------------------------------------------------------

const MULTIHASH_SHA256_HEADER = Buffer.from([0x12, 0x20]);

/**
 * `lesson_hash` for a signed Lesson record — the value stored in
 * `lesson_chain.lesson_hash` and re-derived by every receiver during
 * §5 rule-19 chain validation.
 *
 * Hashes the FULL signed object (signature included), not the
 * canonical-bytes-under-signature surface from `canonicalizeForSigning`.
 * That distinction matters — receivers cannot strip the signature when
 * recomputing the chain hash because the signed_lesson they got off the
 * wire is the source of truth, not the unsigned subset.
 */
export function computeLessonHash(signedLesson: object): string {
  const bytes = Buffer.from(canonicalize(signedLesson), "utf8");
  const digest = createHash("sha256").update(bytes).digest();
  return base58btcEncode(Buffer.concat([MULTIHASH_SHA256_HEADER, digest]));
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The Lesson body the producer hands to the chain hook BEFORE
 * `prev_lesson_hash`, `signed_at`, and `signature` are attached.
 *
 * Structurally a subset of the on-wire `Lesson` interface from
 * `wire-types.ts` — kept narrow on purpose so callers can't accidentally
 * pre-attach `prev_lesson_hash` (it would be silently overwritten) or
 * `signature` (it would land inside the signed bytes and break verify).
 */
export interface UnsignedLesson {
  id: string;
  content: string;
  embedding: number[];
  synthesized_from_cluster_size: number;
  origin_node_id: string;
  created_at: string;
  spec_version: string;
  tags?: string[];
  // v1.1 Proof-of-Knowledge fields (SWARM_SPEC §3.7).
  // The hook does not enforce their presence — that is the validator's
  // job (rules 16/17/20 in §5). When provided, they pass through into
  // the signed bytes.
  evidence_root?: string;
  evidence_count?: number;
  maturity_age_days?: number;
  useful_count?: number;
}

/**
 * The fully-signed Lesson record. Same field set as `UnsignedLesson`
 * plus the three signing additions: `prev_lesson_hash`, `signed_at`,
 * `signature`. This is the on-wire shape the §139 broadcaster will
 * relay to peers.
 */
export interface SignedLesson extends UnsignedLesson {
  prev_lesson_hash: string | null;
  signed_at: string;
  signature: string;
}

/**
 * The chain-tip metadata required to build the next chain entry. Read
 * via `compute_next_prev_lesson_hash()` and `compute_next_sequence_number()`
 * from migration 074. The pair is read together so the hook can validate
 * the first-lesson biconditional (CHECK on the table) before signing —
 * a bad tip read would otherwise produce a record that fails the DB
 * CHECK at INSERT time, after we've already burned a clock tick on
 * `signed_at`.
 */
export interface ChainTip {
  prev_lesson_hash: string | null;
  sequence_number: number;
}

/** A row read out of `lesson_chain`. */
export interface ExistingChainRow {
  lesson_id: string;
  signed_at: string;
  lesson_hash: string;
  prev_lesson_hash: string | null;
  sequence_number: number;
}

/** Payload for a fresh chain INSERT. */
export interface ChainAppendInput {
  lesson_id: string;
  signed_at: string;
  lesson_hash: string;
  prev_lesson_hash: string | null;
  sequence_number: number;
}

/**
 * Sentinel error the dep layer raises on a UNIQUE-constraint conflict
 * during INSERT. The orchestrator inspects the `conflict` field to
 * decide whether to short-circuit (lesson_id race — return the existing
 * row) or retry (sequence_number race — re-read the tip and try again).
 *
 * Default Supabase deps map Postgres error code `23505` to this; tests
 * raise it directly.
 */
export class LessonChainConflictError extends Error {
  constructor(public readonly conflict: "lesson_id" | "sequence_number") {
    super(`lesson_chain UNIQUE conflict on ${conflict}`);
    this.name = "LessonChainConflictError";
  }
}

export interface LessonChainDeps {
  /** Read the chain tip — `compute_next_prev_lesson_hash` + `compute_next_sequence_number`. */
  readChainTip(): Promise<ChainTip>;
  /** Look up an existing chain row by lesson_id; null when absent. */
  loadByLessonId(lessonId: string): Promise<ExistingChainRow | null>;
  /**
   * INSERT one row into `lesson_chain`. MUST raise
   * `LessonChainConflictError` (with the right `conflict` field) on a
   * Postgres UNIQUE-constraint violation; everything else propagates as
   * a normal exception that fails the publish operation.
   */
  insertChainRow(input: ChainAppendInput): Promise<void>;
  /**
   * Sign a record with the node's persistent self-key. Defaults to
   * `signWithSelfKey` (reads `MYCELIUM_NODE_KEY` or `~/.mycelium/node.key`).
   * Tests inject a memory-backed signer.
   */
  signRecord?: <T extends object>(record: T) => SignedRecord<T>;
}

/**
 * Discriminated result so callers can tell a fresh chain entry apart
 * from an idempotent re-publish. The `created` arm carries the signed
 * Lesson (the broadcaster will relay it); the `already_chained` arm
 * carries only the chain row metadata, since the original signed bytes
 * were not retained — the on-wire Lesson is whatever was signed at the
 * original publish time.
 */
export type LessonChainAppendResult =
  | {
      status: "created";
      signed_lesson: SignedLesson;
      lesson_hash: string;
      prev_lesson_hash: string | null;
      sequence_number: number;
    }
  | {
      status: "already_chained";
      lesson_id: string;
      lesson_hash: string;
      prev_lesson_hash: string | null;
      sequence_number: number;
      signed_at: string;
    };

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Bounded number of read-build-sign-insert retries on a parallel
 * `sequence_number` race. Three is generous — the read+sign step is
 * sub-millisecond and a third concurrent publisher on a single mycelium
 * instance would already indicate misconfiguration.
 */
const MAX_SEQUENCE_RACE_RETRIES = 3;

/**
 * Sign a Lesson and append the corresponding row to `lesson_chain`.
 *
 * The five-step contract (matches the runbook in migration 074):
 *
 *   1. Idempotency: if `lesson_chain` already has a row for `lesson.id`,
 *      return its stored hash + sequence_number. No re-signing — the
 *      original signed bytes are the canonical artifact.
 *   2. Read the chain tip and validate the first-lesson biconditional.
 *   3. Build the unsigned record with `prev_lesson_hash` attached.
 *   4. Sign with self-key — `signWithSelfKey` adds `signed_at` inside the
 *      canonical bytes.
 *   5. Compute `lesson_hash` over the signed-with-signature object and
 *      INSERT the chain row. On UNIQUE(sequence_number) race, retry from
 *      step 2; on UNIQUE(lesson_id) race, re-run the idempotency lookup.
 */
export async function signLessonAndAppendToChain(
  deps: LessonChainDeps,
  lesson: UnsignedLesson
): Promise<LessonChainAppendResult> {
  if (!lesson.id) {
    throw new Error(
      "signLessonAndAppendToChain: lesson.id is required (chain row PRIMARY KEY)"
    );
  }
  // Defensive shape pin: callers must NOT pre-attach the three signing
  // fields. Pre-attaching `prev_lesson_hash` would be silently overwritten,
  // which is exactly the silent-divergence surface §3.7.2 forbids.
  for (const forbidden of ["prev_lesson_hash", "signed_at", "signature"]) {
    if (forbidden in (lesson as unknown as Record<string, unknown>)) {
      throw new Error(
        `signLessonAndAppendToChain: lesson must not pre-attach '${forbidden}' — this hook owns it`
      );
    }
  }

  const existing = await deps.loadByLessonId(lesson.id);
  if (existing) {
    return existingChainResult(existing);
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_SEQUENCE_RACE_RETRIES; attempt++) {
    const tip = await deps.readChainTip();
    assertChainTipBiconditional(tip);

    const unsigned = {
      ...lesson,
      prev_lesson_hash: tip.prev_lesson_hash,
    };

    const signer = deps.signRecord ?? signWithSelfKey;
    const signed = signer(unsigned);
    // The fully-signed record IS the on-wire Lesson — signature included
    // in the bytes the chain hash is computed over. Receivers do the same
    // recompute in their rule-19 path, so any drift here = chain breakage.
    const fullySignedRecord = {
      ...signed.record,
      signature: signed.signature,
    } as SignedLesson;
    const lesson_hash = computeLessonHash(fullySignedRecord);

    try {
      await deps.insertChainRow({
        lesson_id: lesson.id,
        signed_at: signed.signed_at,
        lesson_hash,
        prev_lesson_hash: tip.prev_lesson_hash,
        sequence_number: tip.sequence_number,
      });
      return {
        status: "created",
        signed_lesson: fullySignedRecord,
        lesson_hash,
        prev_lesson_hash: tip.prev_lesson_hash,
        sequence_number: tip.sequence_number,
      };
    } catch (e) {
      if (e instanceof LessonChainConflictError) {
        if (e.conflict === "lesson_id") {
          // Another writer just inserted the same lesson_id. Re-run the
          // idempotency lookup and return its row — no second sign attempt.
          const racedRow = await deps.loadByLessonId(lesson.id);
          if (racedRow) {
            return existingChainResult(racedRow);
          }
          // Conflict reported but row not visible — surface as a hard
          // failure rather than retry into an infinite loop.
          throw new Error(
            `signLessonAndAppendToChain: lesson_id conflict reported but row not loadable for ${lesson.id}`
          );
        }
        // sequence_number race — another writer used our slot, retry.
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw new Error(
    `signLessonAndAppendToChain: gave up after ${MAX_SEQUENCE_RACE_RETRIES} sequence_number race retries; last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

function existingChainResult(row: ExistingChainRow): LessonChainAppendResult {
  return {
    status: "already_chained",
    lesson_id: row.lesson_id,
    lesson_hash: row.lesson_hash,
    prev_lesson_hash: row.prev_lesson_hash,
    sequence_number: row.sequence_number,
    signed_at: row.signed_at,
  };
}

/**
 * Pin the migration-074 CHECK invariant in the application layer too.
 * Catching it here turns a lying tip-reader (e.g. one that returns
 * `prev_hash=null` when seq>0 because of a query bug) into a loud
 * pre-INSERT failure rather than a CHECK violation post-sign.
 */
function assertChainTipBiconditional(tip: ChainTip): void {
  const isFirst = tip.sequence_number === 0;
  const hasNullPrev = tip.prev_lesson_hash === null;
  if (isFirst !== hasNullPrev) {
    throw new Error(
      `lesson-chain readChainTip violated SWARM_SPEC §3.7.2 biconditional: sequence_number=${tip.sequence_number}, prev_lesson_hash=${
        tip.prev_lesson_hash === null ? "null" : "present"
      } (must be: seq=0 iff prev=null)`
    );
  }
  if (tip.sequence_number < 0) {
    throw new Error(
      `lesson-chain readChainTip returned negative sequence_number=${tip.sequence_number}`
    );
  }
}

// ---------------------------------------------------------------------------
// Default Supabase-backed deps factory
//
// Lives next to the orchestrator so the future #139 broadcaster wires
// in with one call: `defaultLessonChainDeps(supabase)`. The dep layer
// is the single place that translates Postgres error code `23505`
// (unique_violation) into the discriminated `LessonChainConflictError`
// the orchestrator reasons over.
// ---------------------------------------------------------------------------

const PG_UNIQUE_VIOLATION_CODE = "23505";

/**
 * Map a Postgrest error to a `LessonChainConflictError` when the
 * underlying Postgres error is a UNIQUE-constraint violation on either
 * `lesson_chain.lesson_id` (PRIMARY KEY) or `lesson_chain.sequence_number`.
 *
 * Returns `null` for any other error shape, leaving the caller to throw
 * the original. The constraint-name detection is defensive — Postgres
 * may surface the constraint name in `error.message` via the standard
 * "duplicate key value violates unique constraint "<name>"" wording, but
 * older driver versions only emit the column-mention in the `details`
 * field. Both surfaces are consulted before falling back to a generic
 * `lesson_id` interpretation (the safer default since it short-circuits
 * to the idempotency path rather than retrying forever).
 */
export function detectLessonChainConflict(
  error: { code?: string; message?: string; details?: string } | null
): LessonChainConflictError | null {
  if (!error || error.code !== PG_UNIQUE_VIOLATION_CODE) return null;
  const haystack = `${error.message ?? ""} ${error.details ?? ""}`.toLowerCase();
  if (
    haystack.includes("sequence_number") ||
    haystack.includes("lesson_chain_sequence_number")
  ) {
    return new LessonChainConflictError("sequence_number");
  }
  if (
    haystack.includes("lesson_chain_pkey") ||
    haystack.includes("lesson_id")
  ) {
    return new LessonChainConflictError("lesson_id");
  }
  // Unknown UNIQUE constraint on this table — treat as lesson_id (safer
  // because the orchestrator re-reads and either returns or surfaces a
  // hard failure, rather than spinning on an unbounded retry).
  return new LessonChainConflictError("lesson_id");
}

/**
 * Build a `LessonChainDeps` bag wired against a live Supabase client.
 * #139 (or any other producer surface) calls this and passes the result
 * to `signLessonAndAppendToChain`.
 */
export function defaultLessonChainDeps(db: SupabaseClient): LessonChainDeps {
  return {
    async readChainTip() {
      const [{ data: prev, error: prevErr }, { data: seq, error: seqErr }] =
        await Promise.all([
          db.rpc("compute_next_prev_lesson_hash"),
          db.rpc("compute_next_sequence_number"),
        ]);
      if (prevErr) {
        throw new Error(
          `lesson-chain compute_next_prev_lesson_hash failed: ${prevErr.message}`
        );
      }
      if (seqErr) {
        throw new Error(
          `lesson-chain compute_next_sequence_number failed: ${seqErr.message}`
        );
      }
      return {
        prev_lesson_hash: (prev as string | null) ?? null,
        sequence_number: typeof seq === "number" ? seq : Number(seq ?? 0),
      };
    },
    async loadByLessonId(lessonId) {
      const { data, error } = await db
        .from("lesson_chain")
        .select(
          "lesson_id, signed_at, lesson_hash, prev_lesson_hash, sequence_number"
        )
        .eq("lesson_id", lessonId)
        .maybeSingle();
      if (error) {
        throw new Error(
          `lesson-chain loadByLessonId failed: ${error.message}`
        );
      }
      if (!data) return null;
      return {
        lesson_id: data.lesson_id,
        signed_at: data.signed_at,
        lesson_hash: data.lesson_hash,
        prev_lesson_hash: data.prev_lesson_hash ?? null,
        sequence_number: data.sequence_number,
      };
    },
    async insertChainRow(input) {
      const { error } = await db.from("lesson_chain").insert({
        lesson_id: input.lesson_id,
        signed_at: input.signed_at,
        lesson_hash: input.lesson_hash,
        prev_lesson_hash: input.prev_lesson_hash,
        sequence_number: input.sequence_number,
      });
      if (error) {
        const conflict = detectLessonChainConflict(error);
        if (conflict) throw conflict;
        throw new Error(`lesson-chain insertChainRow failed: ${error.message}`);
      }
    },
  };
}
