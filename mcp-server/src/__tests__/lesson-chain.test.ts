/**
 * Producer-side lesson_chain hook unit tests — Swarm sub-phase 4d (issue #136).
 *
 * Three layers of coverage matching the surrounding 4i/4h orchestrator
 * pattern (rem-promotion, rem-audit, lesson-contradiction-gate):
 *
 *   * Pure helpers (`computeLessonHash`, `detectLessonChainConflict`)
 *     tested against bare object inputs — deterministic boundary checks.
 *   * Orchestrator (`signLessonAndAppendToChain`) tested against an
 *     in-memory dep stub — verifies the chain monotone-grows, signing
 *     bakes `prev_lesson_hash` into the signed bytes, idempotency
 *     short-circuits, and atomicity holds when the INSERT throws.
 *   * Race protection — both the lesson_id and sequence_number conflict
 *     paths are exercised end-to-end so a future migration that drops
 *     either UNIQUE constraint surfaces immediately.
 *
 * Acceptance criteria from #136 mapped to tests below:
 *   1. Chain monotonically grows across N publishes with prev linkage  → "monotone chain"
 *   2. First-ever lesson has prev=null and seq=0                       → "first lesson invariant"
 *   3. Re-signing same lesson_id is a no-op                            → "idempotent on lesson_id"
 *   4. INSERT failure means publish fails as a unit                    → "atomicity on INSERT failure"
 *   5. End-to-end sign → chain → query                                 → "sign-and-append happy path"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createHash } from "node:crypto";

import {
  signLessonAndAppendToChain,
  computeLessonHash,
  detectLessonChainConflict,
  LessonChainConflictError,
  type ChainAppendInput,
  type ChainTip,
  type ExistingChainRow,
  type LessonChainDeps,
  type UnsignedLesson,
} from "../services/lesson-chain.js";
import {
  signWithSelfKey,
  verify,
  canonicalize,
} from "../services/signature.js";
import { base58btcEncode } from "../services/node-identity.js";

// ---------------------------------------------------------------------------
// Identity + lesson fixture helpers
// ---------------------------------------------------------------------------

interface Identity {
  pem: string;
  pubkeyRaw: Uint8Array;
}

function freshIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubkeyRaw = new Uint8Array(spki.subarray(spki.length - 32));
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return { pem, pubkeyRaw };
}

function makeUnsignedLesson(overrides: Partial<UnsignedLesson> = {}): UnsignedLesson {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    content: "Sign Lesson records before broadcast.",
    embedding: Array.from({ length: 8 }, (_, i) => i / 100),
    synthesized_from_cluster_size: 3,
    origin_node_id: "QmTestNodeIdAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    created_at: "2026-04-25T08:00:00.000Z",
    spec_version: "1.1",
    tags: ["swarm", "test"],
    evidence_root: "QmEvidenceRootAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    evidence_count: 3,
    maturity_age_days: 5,
    useful_count: 2,
    ...overrides,
  };
}

/**
 * In-memory chain store + LessonChainDeps factory. Mirrors the
 * makeDeps() pattern in rem-promotion.test.ts: callers can override
 * specific behaviours (raise on insert, short-circuit reads, …) without
 * re-implementing the rest of the bag.
 */
function makeDeps(opts: {
  signer: <T extends object>(record: T) => ReturnType<typeof signWithSelfKey<T>>;
  override?: Partial<LessonChainDeps>;
  // Inject a fixed clock sequence so signed_at values are deterministic.
  clock?: () => Date;
}): { deps: LessonChainDeps; rows: ExistingChainRow[] } {
  const rows: ExistingChainRow[] = [];
  const baseDeps: LessonChainDeps = {
    async readChainTip(): Promise<ChainTip> {
      if (rows.length === 0) {
        return { prev_lesson_hash: null, sequence_number: 0 };
      }
      const tip = rows[rows.length - 1];
      return {
        prev_lesson_hash: tip.lesson_hash,
        sequence_number: tip.sequence_number + 1,
      };
    },
    async loadByLessonId(lessonId): Promise<ExistingChainRow | null> {
      return rows.find((r) => r.lesson_id === lessonId) ?? null;
    },
    async insertChainRow(input: ChainAppendInput): Promise<void> {
      if (rows.some((r) => r.lesson_id === input.lesson_id)) {
        throw new LessonChainConflictError("lesson_id");
      }
      if (rows.some((r) => r.sequence_number === input.sequence_number)) {
        throw new LessonChainConflictError("sequence_number");
      }
      rows.push({
        lesson_id: input.lesson_id,
        signed_at: input.signed_at,
        lesson_hash: input.lesson_hash,
        prev_lesson_hash: input.prev_lesson_hash,
        sequence_number: input.sequence_number,
      });
    },
    signRecord: opts.signer,
  };
  const deps: LessonChainDeps = { ...baseDeps, ...(opts.override ?? {}) };
  return { deps, rows };
}

function fixedClockSequence(times: string[]): () => Date {
  let i = 0;
  return () => {
    if (i >= times.length) {
      throw new Error(
        `fixedClockSequence: ran out of times after ${times.length} reads`
      );
    }
    return new Date(times[i++]);
  };
}

// ---------------------------------------------------------------------------
// (1) Pure helpers
// ---------------------------------------------------------------------------

test("computeLessonHash produces a 46-char base58btc sha2-256 multihash", () => {
  const sample = {
    id: "00000000-0000-4000-8000-000000000000",
    content: "x",
    signed_at: "2026-04-25T08:00:00.000Z",
    signature: "AAAA",
  };
  const hash = computeLessonHash(sample);
  // Same shape as node_id and the evidence-merkle leaves: deterministic
  // 46-character base58btc representation of a 34-byte multihash.
  assert.equal(hash.length, 46);
  assert.match(hash, /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
});

test("computeLessonHash matches a hand-rolled multihash(sha2-256, JCS)", () => {
  // Independent recomputation: if computeLessonHash drifts from the
  // canonicalize+sha256 contract, every receiver's chain validation
  // breaks. Pin it so the test fails BEFORE that hits production.
  const record = { b: 2, a: 1, signature: "deadbeef" };
  const expected = (() => {
    const bytes = Buffer.from(canonicalize(record), "utf8");
    const digest = createHash("sha256").update(bytes).digest();
    const multihash = Buffer.concat([Buffer.from([0x12, 0x20]), digest]);
    return base58btcEncode(multihash);
  })();
  assert.equal(computeLessonHash(record), expected);
});

test("computeLessonHash includes signature in the bytes (mutation detected)", () => {
  // The chain hash MUST cover the full signed object, not just the
  // canonical-bytes-under-signature surface. If signature were silently
  // stripped, swapping a valid signature for a forged one would not
  // change the chain hash and an attacker could re-anchor history.
  const a = { id: "x", signature: "AAAA" };
  const b = { id: "x", signature: "BBBB" };
  assert.notEqual(computeLessonHash(a), computeLessonHash(b));
});

test("detectLessonChainConflict maps Postgres 23505 on sequence_number to a sequence_number conflict", () => {
  const conflict = detectLessonChainConflict({
    code: "23505",
    message:
      'duplicate key value violates unique constraint "lesson_chain_sequence_number_key"',
    details: "Key (sequence_number)=(5) already exists.",
  });
  assert.ok(conflict);
  assert.equal(conflict.conflict, "sequence_number");
});

test("detectLessonChainConflict maps Postgres 23505 on lesson_chain_pkey to a lesson_id conflict", () => {
  const conflict = detectLessonChainConflict({
    code: "23505",
    message:
      'duplicate key value violates unique constraint "lesson_chain_pkey"',
    details: "Key (lesson_id)=(11111111-2222-4333-8444-555555555555) already exists.",
  });
  assert.ok(conflict);
  assert.equal(conflict.conflict, "lesson_id");
});

test("detectLessonChainConflict returns null for unrelated error codes", () => {
  // 23502 is not_null_violation — must NOT be coerced into a UNIQUE
  // conflict, otherwise a real schema error would silently retry.
  assert.equal(
    detectLessonChainConflict({
      code: "23502",
      message: 'null value in column "lesson_hash"',
    }),
    null
  );
  assert.equal(detectLessonChainConflict(null), null);
  assert.equal(detectLessonChainConflict({}), null);
});

// ---------------------------------------------------------------------------
// (2) Orchestrator — sign-and-append happy path + invariants
// ---------------------------------------------------------------------------

test("signLessonAndAppendToChain — first lesson has prev_lesson_hash=null and sequence_number=0", async () => {
  const self = freshIdentity();
  const { deps, rows } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: fixedClockSequence(["2026-04-25T08:00:00.000Z"]),
      }),
  });

  const result = await signLessonAndAppendToChain(deps, makeUnsignedLesson());

  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(result.prev_lesson_hash, null);
  assert.equal(result.sequence_number, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prev_lesson_hash, null);
  assert.equal(rows[0].sequence_number, 0);

  // Sanity: the signed lesson verifies under its own key. If signing
  // somehow produced bytes that didn't match the verify path, the chain
  // would never round-trip on a receiver.
  assert.ok(
    verify(result.signed_lesson, result.signed_lesson.signature, self.pubkeyRaw),
    "signed lesson must verify under producer pubkey"
  );
});

test("signLessonAndAppendToChain — signs prev_lesson_hash INTO the canonical bytes", async () => {
  // The §3.7.2 invariant: prev_lesson_hash must be inside the bytes the
  // signature covers. Swapping prev after sign-time would break this; pin
  // it by tampering with prev on a clone and asserting verify rejects.
  const self = freshIdentity();
  const { deps } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: fixedClockSequence(["2026-04-25T08:00:00.000Z", "2026-04-25T08:01:00.000Z"]),
      }),
  });

  await signLessonAndAppendToChain(deps, makeUnsignedLesson());
  const second = await signLessonAndAppendToChain(
    deps,
    makeUnsignedLesson({ id: "22222222-3333-4444-8555-666666666666" })
  );
  assert.equal(second.status, "created");
  if (second.status !== "created") return;

  // Tamper: swap prev_lesson_hash to null. Verify must fail because
  // prev was inside the signed JCS bytes.
  const tampered = { ...second.signed_lesson, prev_lesson_hash: null };
  assert.equal(
    verify(tampered, tampered.signature, self.pubkeyRaw),
    false,
    "tampering with prev_lesson_hash post-sign must invalidate signature"
  );
});

test("signLessonAndAppendToChain — N publishes form a monotone chain with correct prev linkage", async () => {
  const self = freshIdentity();
  const N = 4;
  const times = Array.from(
    { length: N },
    (_, i) => `2026-04-25T08:0${i}:00.000Z`
  );
  const { deps, rows } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: fixedClockSequence(times),
      }),
  });

  const lessonIds = [
    "aaaaaaaa-1111-4111-8111-111111111111",
    "bbbbbbbb-2222-4222-8222-222222222222",
    "cccccccc-3333-4333-8333-333333333333",
    "dddddddd-4444-4444-8444-444444444444",
  ];
  for (const id of lessonIds) {
    const r = await signLessonAndAppendToChain(deps, makeUnsignedLesson({ id }));
    assert.equal(r.status, "created");
  }

  assert.equal(rows.length, N);

  // Sequence numbers strictly increase from 0.
  for (let i = 0; i < N; i++) {
    assert.equal(rows[i].sequence_number, i, `row ${i} sequence_number`);
  }
  // First row has null prev; every subsequent row's prev equals the
  // previous row's lesson_hash. That is the §3.7.2 chain invariant.
  assert.equal(rows[0].prev_lesson_hash, null);
  for (let i = 1; i < N; i++) {
    assert.equal(
      rows[i].prev_lesson_hash,
      rows[i - 1].lesson_hash,
      `row ${i} prev_lesson_hash must equal row ${i - 1} lesson_hash`
    );
  }
  // All hashes are distinct — same lesson_id reuse would have collapsed
  // them, so this is a useful sanity check on the test itself too.
  const uniqueHashes = new Set(rows.map((r) => r.lesson_hash));
  assert.equal(uniqueHashes.size, N);
});

// ---------------------------------------------------------------------------
// (3) Idempotency — re-signing the same lesson_id is a no-op
// ---------------------------------------------------------------------------

test("signLessonAndAppendToChain — re-signing the same lesson_id returns the existing chain row, no second insert", async () => {
  const self = freshIdentity();
  const { deps, rows } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: fixedClockSequence([
          "2026-04-25T08:00:00.000Z",
          "2026-04-25T08:01:00.000Z", // would be used if a 2nd sign happened
        ]),
      }),
  });
  const lesson = makeUnsignedLesson();

  const first = await signLessonAndAppendToChain(deps, lesson);
  assert.equal(first.status, "created");

  const second = await signLessonAndAppendToChain(deps, lesson);
  assert.equal(second.status, "already_chained");
  if (second.status !== "already_chained") return;

  // Same hash, same sequence_number, same signed_at — the existing row
  // is the source of truth.
  if (first.status === "created") {
    assert.equal(second.lesson_hash, first.lesson_hash);
    assert.equal(second.sequence_number, first.sequence_number);
  }
  // No second chain row was written.
  assert.equal(rows.length, 1);
});

test("signLessonAndAppendToChain — TOCTOU: lesson_id race after idempotency check returns the racing row", async () => {
  // Models the case where loadByLessonId returns null but a parallel
  // writer inserts the same lesson_id between read and our INSERT.
  // After the INSERT raises lesson_id-conflict, the orchestrator must
  // re-load and surface the racing row rather than retrying or throwing.
  const self = freshIdentity();
  const racingRow: ExistingChainRow = {
    lesson_id: "11111111-2222-4333-8444-555555555555",
    signed_at: "2026-04-25T08:00:00.000Z",
    lesson_hash: "QmRacingHashAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    prev_lesson_hash: null,
    sequence_number: 0,
  };

  let loadCalls = 0;
  const deps: LessonChainDeps = {
    async readChainTip() {
      return { prev_lesson_hash: null, sequence_number: 0 };
    },
    async loadByLessonId() {
      loadCalls += 1;
      // First lookup (idempotency check) — null. Second lookup (after
      // the conflict surfaced from INSERT) — return the racing row.
      return loadCalls === 1 ? null : racingRow;
    },
    async insertChainRow() {
      throw new LessonChainConflictError("lesson_id");
    },
    signRecord: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  };

  const result = await signLessonAndAppendToChain(deps, makeUnsignedLesson());
  assert.equal(result.status, "already_chained");
  if (result.status !== "already_chained") return;
  assert.equal(result.lesson_hash, racingRow.lesson_hash);
  assert.equal(loadCalls, 2);
});

// ---------------------------------------------------------------------------
// (4) Sequence_number race — bounded retry up to MAX_SEQUENCE_RACE_RETRIES
// ---------------------------------------------------------------------------

test("signLessonAndAppendToChain — recovers from a single sequence_number race", async () => {
  // First INSERT raises sequence_number-conflict; second succeeds. The
  // orchestrator must re-read the tip (which advanced) and re-sign.
  const self = freshIdentity();
  let attempts = 0;
  let nextSeq = 0;
  let nextPrev: string | null = null;
  const inserted: ChainAppendInput[] = [];
  const deps: LessonChainDeps = {
    async readChainTip() {
      return { prev_lesson_hash: nextPrev, sequence_number: nextSeq };
    },
    async loadByLessonId() {
      return null;
    },
    async insertChainRow(input) {
      attempts += 1;
      if (attempts === 1) {
        // Simulate a parallel writer claiming our slot: bump the tip and
        // raise the conflict so the orchestrator retries.
        nextSeq = 1;
        nextPrev = "QmParallelWriterHashAAAAAAAAAAAAAAAAAAAAAAAAAA";
        throw new LessonChainConflictError("sequence_number");
      }
      inserted.push(input);
    },
    signRecord: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: fixedClockSequence([
          "2026-04-25T08:00:00.000Z",
          "2026-04-25T08:00:01.000Z",
        ]),
      }),
  };

  const result = await signLessonAndAppendToChain(deps, makeUnsignedLesson());
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  assert.equal(attempts, 2, "INSERT must have been retried once");
  // Final write used the post-race tip (seq=1, prev=racing-writer-hash).
  assert.equal(result.sequence_number, 1);
  assert.equal(
    result.prev_lesson_hash,
    "QmParallelWriterHashAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].sequence_number, 1);
});

test("signLessonAndAppendToChain — gives up after MAX_SEQUENCE_RACE_RETRIES on a perpetual race", async () => {
  // Pathological dep that always raises sequence_number conflict — the
  // orchestrator must throw, NOT spin forever.
  const self = freshIdentity();
  let attempts = 0;
  const deps: LessonChainDeps = {
    async readChainTip() {
      return { prev_lesson_hash: null, sequence_number: 0 };
    },
    async loadByLessonId() {
      return null;
    },
    async insertChainRow() {
      attempts += 1;
      throw new LessonChainConflictError("sequence_number");
    },
    signRecord: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  };

  await assert.rejects(
    () => signLessonAndAppendToChain(deps, makeUnsignedLesson()),
    /gave up after \d+ sequence_number race retries/
  );
  // Bounded: should be MAX_SEQUENCE_RACE_RETRIES (3 in current impl).
  assert.ok(attempts >= 2 && attempts <= 5, `attempts=${attempts}`);
});

// ---------------------------------------------------------------------------
// (5) Atomicity — non-conflict INSERT failure fails the publish operation
// ---------------------------------------------------------------------------

test("signLessonAndAppendToChain — INSERT failure (non-conflict) propagates as a publish failure", async () => {
  const self = freshIdentity();
  const deps: LessonChainDeps = {
    async readChainTip() {
      return { prev_lesson_hash: null, sequence_number: 0 };
    },
    async loadByLessonId() {
      return null;
    },
    async insertChainRow() {
      throw new Error("simulated network outage");
    },
    signRecord: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  };

  await assert.rejects(
    () => signLessonAndAppendToChain(deps, makeUnsignedLesson()),
    /simulated network outage/
  );
});

// ---------------------------------------------------------------------------
// (6) Defensive shape pins — caller must not pre-attach signing fields
// ---------------------------------------------------------------------------

test("signLessonAndAppendToChain — rejects pre-attached prev_lesson_hash / signed_at / signature", async () => {
  const self = freshIdentity();
  const { deps } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  });
  for (const forbidden of ["prev_lesson_hash", "signed_at", "signature"]) {
    const lesson = {
      ...makeUnsignedLesson(),
      [forbidden]: "anything",
    } as UnsignedLesson;
    await assert.rejects(
      () => signLessonAndAppendToChain(deps, lesson),
      new RegExp(`must not pre-attach '${forbidden}'`),
      `pre-attaching ${forbidden} must throw`
    );
  }
});

test("signLessonAndAppendToChain — rejects empty lesson.id", async () => {
  const self = freshIdentity();
  const { deps } = makeDeps({
    signer: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  });
  await assert.rejects(
    () => signLessonAndAppendToChain(deps, makeUnsignedLesson({ id: "" })),
    /lesson\.id is required/
  );
});

test("signLessonAndAppendToChain — surfaces a chain-tip biconditional violation as a loud failure", async () => {
  // A buggy tip-reader returning seq>0 with prev=null would silently
  // produce a record that fails the migration-074 CHECK at INSERT time.
  // The orchestrator must catch this BEFORE signing so the failure is
  // attributable and `signed_at` doesn't drift.
  const self = freshIdentity();
  const deps: LessonChainDeps = {
    async readChainTip() {
      return { prev_lesson_hash: null, sequence_number: 5 };
    },
    async loadByLessonId() {
      return null;
    },
    async insertChainRow() {
      throw new Error("should not have reached INSERT");
    },
    signRecord: (r) =>
      signWithSelfKey(r, {
        loadPem: () => self.pem,
        now: () => new Date("2026-04-25T08:00:00.000Z"),
      }),
  };
  await assert.rejects(
    () => signLessonAndAppendToChain(deps, makeUnsignedLesson()),
    /SWARM_SPEC §3\.7\.2 biconditional/
  );
});
