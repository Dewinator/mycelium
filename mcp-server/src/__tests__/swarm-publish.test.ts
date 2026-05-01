import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SwarmPublishService,
  assertLocalLessonPublishable,
  assertChainTipBiconditional,
  buildUnsignedSwarmLesson,
  parsePublishOutcome,
  isSequenceNumberRaceError,
  DEFAULT_SPEC_VERSION,
  MAX_SEQUENCE_RACE_RETRIES,
  type LocalLessonRow,
  type SwarmPublishDeps,
  type PublishChainTip,
} from "../services/swarm-publish.js";
import {
  swarmPublishTierAlesson,
  swarmPublishTierAlessonSchema,
} from "../tools/swarm-publish.js";
import type { SignedRecord } from "../services/signature.js";

// ---------------------------------------------------------------------------
// swarm_publish_tier_a_lesson — issue #143 write-side slice
//
// What this exercises:
//   1. assertLocalLessonPublishable — pre-sign validation traps every
//      §3.1 / §5 / migration-071 invariant before a signing call wastes a
//      clock tick or the orchestrator hits an opaque RPC raise.
//   2. assertChainTipBiconditional — the publish path refuses to sign on
//      a malformed chain tip (seq=0 iff prev=null), mirroring the
//      lesson-chain.ts pin so a bad tip never produces signed bytes.
//   3. buildUnsignedSwarmLesson — pure shape transformation, no clock,
//      no randomness.
//   4. parsePublishOutcome — the migration-087 RPC's JSONB body is
//      strictly narrowed onto the discriminated union; shape drift fails
//      loud rather than landing as `unknown` in the tool layer.
//   5. SwarmPublishService.publishTierA — orchestrator behavior on the
//      happy path, the already-published idempotency path, the
//      sequence_number race retry loop (success on retry, exhaustion on
//      persistent contention), and the validation/identity error paths.
//   6. The MCP tool's ethics-gate refuses without
//      OPENCLAW_ALLOW_SWARM_WRITE=1 (mirrors swarm_pin / swarm_resolve)
//      and the Zod schema rejects malformed inputs.
// ---------------------------------------------------------------------------

const FAKE_LESSON_ID = "11111111-2222-3333-4444-555555555555";
const FAKE_NODE_ID = "node-self-aaaa";

function makeLocalRow(overrides: Partial<LocalLessonRow> = {}): LocalLessonRow {
  return {
    id: FAKE_LESSON_ID,
    content: "When the chain tip races, retry with a fresh prev_hash.",
    embedding: new Array(768).fill(0).map((_, i) => (i % 17) / 100),
    evidence_count: 5,
    created_at: "2026-05-01T12:00:00.000Z",
    tags: ["swarm", "publish"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) assertLocalLessonPublishable
// ---------------------------------------------------------------------------

test("assertLocalLessonPublishable accepts a well-formed row", () => {
  assert.doesNotThrow(() => assertLocalLessonPublishable(makeLocalRow()));
});

test("assertLocalLessonPublishable rejects empty content (§5 rule 13 surface)", () => {
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ content: "   " })),
    /content is empty/i,
  );
});

test("assertLocalLessonPublishable rejects evidence_count < 2 (§3.1 cluster floor)", () => {
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ evidence_count: 1 })),
    /evidence_count must be >= 2/,
  );
});

test("assertLocalLessonPublishable rejects content exceeding 8192 octets (§5 rule 12)", () => {
  // 9000 ASCII chars = 9000 octets, comfortably over the 8192 cap.
  const huge = "x".repeat(9000);
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ content: huge })),
    /exceeds 8192 octets/,
  );
});

test("assertLocalLessonPublishable enforces 8192 octets in OCTETS not characters", () => {
  // 4-byte emoji * 2049 = 8196 octets > 8192. Char count is 2049 — well
  // under any naive char limit. The validator MUST measure octets.
  const emoji = "🌱"; // 4 bytes UTF-8
  const content = emoji.repeat(2049);
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ content })),
    /exceeds 8192 octets/,
  );
});

test("assertLocalLessonPublishable rejects wrong embedding dimension (pgvector(768))", () => {
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ embedding: [0.1, 0.2] })),
    /768-dim/,
  );
});

test("assertLocalLessonPublishable rejects missing id", () => {
  assert.throws(
    () => assertLocalLessonPublishable(makeLocalRow({ id: "" })),
    /missing id/,
  );
});

// ---------------------------------------------------------------------------
// (2) assertChainTipBiconditional
// ---------------------------------------------------------------------------

test("assertChainTipBiconditional accepts the genesis case (seq=0, prev=null)", () => {
  assert.doesNotThrow(() =>
    assertChainTipBiconditional({ sequence_number: 0, prev_lesson_hash: null }),
  );
});

test("assertChainTipBiconditional accepts the steady-state case (seq>0, prev=hash)", () => {
  assert.doesNotThrow(() =>
    assertChainTipBiconditional({
      sequence_number: 7,
      prev_lesson_hash: "z-prev-hash",
    }),
  );
});

test("assertChainTipBiconditional rejects (seq=0, prev=hash)", () => {
  assert.throws(
    () =>
      assertChainTipBiconditional({
        sequence_number: 0,
        prev_lesson_hash: "z-stray",
      }),
    /biconditional violated/,
  );
});

test("assertChainTipBiconditional rejects (seq>0, prev=null)", () => {
  assert.throws(
    () =>
      assertChainTipBiconditional({
        sequence_number: 1,
        prev_lesson_hash: null,
      }),
    /biconditional violated/,
  );
});

test("assertChainTipBiconditional rejects negative sequence_number (post-biconditional)", () => {
  // Use prev_hash != null so the biconditional passes (seq=0 iff prev=null)
  // and we reach the negative-sequence check.
  assert.throws(
    () =>
      assertChainTipBiconditional({
        sequence_number: -1,
        prev_lesson_hash: "z-some-hash",
      }),
    /negative sequence_number/,
  );
});

// ---------------------------------------------------------------------------
// (3) buildUnsignedSwarmLesson
// ---------------------------------------------------------------------------

test("buildUnsignedSwarmLesson maps row → UnsignedLesson with self origin", () => {
  const out = buildUnsignedSwarmLesson(makeLocalRow(), FAKE_NODE_ID, "1.1");
  assert.equal(out.id, FAKE_LESSON_ID);
  assert.equal(out.origin_node_id, FAKE_NODE_ID);
  assert.equal(out.synthesized_from_cluster_size, 5);
  assert.equal(out.spec_version, "1.1");
  assert.equal(out.created_at, "2026-05-01T12:00:00.000Z");
  assert.deepEqual(out.tags, ["swarm", "publish"]);
});

test("buildUnsignedSwarmLesson defaults missing tags to []", () => {
  const out = buildUnsignedSwarmLesson(
    makeLocalRow({ tags: null }),
    FAKE_NODE_ID,
    "1.1",
  );
  assert.deepEqual(out.tags, []);
});

test("buildUnsignedSwarmLesson rejects empty selfNodeId — would produce an unsignable origin", () => {
  assert.throws(
    () => buildUnsignedSwarmLesson(makeLocalRow(), "", "1.1"),
    /selfNodeId is required/,
  );
});

test("buildUnsignedSwarmLesson is a pure transform (no clock, no randomness)", () => {
  const a = buildUnsignedSwarmLesson(makeLocalRow(), FAKE_NODE_ID, "1.1");
  const b = buildUnsignedSwarmLesson(makeLocalRow(), FAKE_NODE_ID, "1.1");
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// (4) parsePublishOutcome
// ---------------------------------------------------------------------------

test("parsePublishOutcome narrows the published JSONB body", () => {
  const raw = {
    ok: true,
    status: "published",
    lesson_id: FAKE_LESSON_ID,
    origin_node_id: FAKE_NODE_ID,
    lesson_tier: "A",
    sequence_number: 3,
    lesson_hash: "z-hash",
    audit_reason: "tool-publish: smoke test",
    signed_at: "2026-05-01T12:34:56.000Z",
    received_at: "2026-05-01T12:34:56.123Z",
  };
  const out = parsePublishOutcome(raw);
  assert.equal(out.status, "published");
  if (out.status === "published") {
    assert.equal(out.sequence_number, 3);
    assert.equal(out.lesson_hash, "z-hash");
    assert.equal(out.audit_reason, "tool-publish: smoke test");
  }
});

test("parsePublishOutcome narrows the already_published JSONB body", () => {
  const out = parsePublishOutcome({
    ok: true,
    status: "already_published",
    lesson_id: FAKE_LESSON_ID,
    lesson_tier: "A",
    chain_present: true,
  });
  assert.equal(out.status, "already_published");
  if (out.status === "already_published") {
    assert.equal(out.chain_present, true);
  }
});

test("parsePublishOutcome rejects ok=false bodies", () => {
  assert.throws(
    () => parsePublishOutcome({ ok: false, status: "published" }),
    /ok flag missing or not true/,
  );
});

test("parsePublishOutcome rejects unknown status (catches future RPC drift)", () => {
  assert.throws(
    () =>
      parsePublishOutcome({
        ok: true,
        status: "promoted",
        lesson_id: FAKE_LESSON_ID,
      }),
    /unexpected status/,
  );
});

test("parsePublishOutcome rejects non-object input", () => {
  assert.throws(() => parsePublishOutcome(null), /expected JSONB object/);
  assert.throws(() => parsePublishOutcome([]), /expected JSONB object/);
  assert.throws(() => parsePublishOutcome("string"), /expected JSONB object/);
});

test("parsePublishOutcome rejects missing fields on the published arm", () => {
  assert.throws(
    () =>
      parsePublishOutcome({
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        // missing origin_node_id, sequence_number, etc.
      }),
    /missing or not a string/,
  );
});

// ---------------------------------------------------------------------------
// (5) isSequenceNumberRaceError
// ---------------------------------------------------------------------------

test("isSequenceNumberRaceError matches the migration-087 raise prefix", () => {
  const err = new Error(
    "operator_publish_tier_a_lesson: lesson_chain_sequence_number_race (UNIQUE violation)",
  );
  assert.equal(isSequenceNumberRaceError(err), true);
});

test("isSequenceNumberRaceError ignores unrelated errors", () => {
  assert.equal(
    isSequenceNumberRaceError(new Error("RPC timeout")),
    false,
  );
  assert.equal(
    isSequenceNumberRaceError(
      new Error("operator_publish_tier_a_lesson: swarm_lessons_id_race"),
    ),
    false,
  );
});

test("isSequenceNumberRaceError handles non-Error throws", () => {
  assert.equal(isSequenceNumberRaceError("lesson_chain_sequence_number_race"), true);
  assert.equal(isSequenceNumberRaceError(42), false);
});

// ---------------------------------------------------------------------------
// (6) SwarmPublishService.publishTierA — orchestrator
// ---------------------------------------------------------------------------

interface RecordedCalls {
  loaded:    string[];
  selfReads: number;
  tipReads:  number;
  rpcCalls:  Array<{ sequence: number; prev_hash: string | null; lesson_hash: string }>;
  signs:     number;
}

interface MakeDepsOpts {
  row?: LocalLessonRow | null;
  self?: string | null;
  tips?: PublishChainTip[];
  rpcOutcomes?: Array<unknown | Error>;
}

function makeDeps(
  opts: MakeDepsOpts = {},
): { deps: SwarmPublishDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = {
    loaded:    [],
    selfReads: 0,
    tipReads:  0,
    rpcCalls:  [],
    signs:     0,
  };
  const tips = opts.tips ?? [
    { sequence_number: 0, prev_lesson_hash: null },
  ];
  const rpcOutcomes = opts.rpcOutcomes ?? [];
  let tipIdx = 0;
  let rpcIdx = 0;

  const deps: SwarmPublishDeps = {
    async loadLocalLesson(id) {
      calls.loaded.push(id);
      return opts.row === undefined ? makeLocalRow() : opts.row;
    },
    async loadSelfNodeId() {
      calls.selfReads++;
      return opts.self === undefined ? FAKE_NODE_ID : opts.self;
    },
    async readChainTip() {
      calls.tipReads++;
      const tip = tips[Math.min(tipIdx, tips.length - 1)];
      tipIdx++;
      return tip;
    },
    async callOperatorPublishTierA(args) {
      calls.rpcCalls.push({
        sequence:    args.sequence,
        prev_hash:   args.prev_hash,
        lesson_hash: args.lesson_hash,
      });
      const outcome = rpcOutcomes[Math.min(rpcIdx, rpcOutcomes.length - 1)];
      rpcIdx++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    signRecord: <T extends object>(record: T): SignedRecord<T> => {
      calls.signs++;
      const signed_at = "2026-05-01T12:34:56.000Z";
      const payload = { ...record, signed_at } as T & { signed_at: string };
      return {
        record:    payload,
        signature: `sig-${calls.signs}`,
        signed_at,
      };
    },
  };
  return { deps, calls };
}

test("publishTierA — happy path: validates, signs once, calls RPC once, returns published", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({
    rpcOutcomes: [
      {
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        origin_node_id: FAKE_NODE_ID,
        lesson_tier: "A",
        sequence_number: 0,
        lesson_hash: "z-fresh",
        audit_reason: "tool-publish",
        signed_at: "2026-05-01T12:34:56.000Z",
        received_at: "2026-05-01T12:34:56.100Z",
      },
    ],
  });
  const out = await svc.publishTierA(FAKE_LESSON_ID, {}, deps);
  assert.equal(out.status, "published");
  assert.equal(calls.signs, 1, "should sign exactly once on a clean publish");
  assert.equal(calls.rpcCalls.length, 1);
  assert.equal(calls.rpcCalls[0].sequence, 0);
  assert.equal(calls.rpcCalls[0].prev_hash, null);
});

test("publishTierA — already_published RPC body is propagated as the typed outcome", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({
    rpcOutcomes: [
      {
        ok: true,
        status: "already_published",
        lesson_id: FAKE_LESSON_ID,
        lesson_tier: "A",
        chain_present: true,
      },
    ],
  });
  const out = await svc.publishTierA(FAKE_LESSON_ID, {}, deps);
  assert.equal(out.status, "already_published");
  if (out.status === "already_published") {
    assert.equal(out.chain_present, true);
  }
  // Even on the no-op path the orchestrator MUST do a sign — the RPC
  // contract requires the signature payload regardless. The DB short-
  // circuits inside the txn; the TS layer can't tell ahead of time.
  assert.equal(calls.signs, 1);
});

test("publishTierA — sequence_number race: retries with a fresh tip and succeeds", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({
    tips: [
      { sequence_number: 5, prev_lesson_hash: "z-old" },
      { sequence_number: 6, prev_lesson_hash: "z-new" },
    ],
    rpcOutcomes: [
      new Error(
        "operator_publish_tier_a_lesson: lesson_chain_sequence_number_race (...)",
      ),
      {
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        origin_node_id: FAKE_NODE_ID,
        lesson_tier: "A",
        sequence_number: 6,
        lesson_hash: "z-second",
        audit_reason: "tool-publish",
        signed_at: "2026-05-01T12:34:56.000Z",
        received_at: "2026-05-01T12:34:57.000Z",
      },
    ],
  });
  const out = await svc.publishTierA(FAKE_LESSON_ID, {}, deps);
  assert.equal(out.status, "published");
  assert.equal(calls.tipReads, 2, "must re-read tip on race");
  assert.equal(calls.signs, 2, "must re-sign on race because prev_hash changed");
  assert.equal(calls.rpcCalls.length, 2);
  assert.equal(calls.rpcCalls[0].sequence, 5);
  assert.equal(calls.rpcCalls[1].sequence, 6);
  assert.equal(calls.rpcCalls[1].prev_hash, "z-new");
});

test("publishTierA — exhausts the retry budget on persistent contention", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const raceErr = new Error(
    "operator_publish_tier_a_lesson: lesson_chain_sequence_number_race",
  );
  const { deps, calls } = makeDeps({
    tips: [{ sequence_number: 1, prev_lesson_hash: "z-prev" }],
    rpcOutcomes: [raceErr, raceErr, raceErr, raceErr],
  });
  await assert.rejects(
    svc.publishTierA(FAKE_LESSON_ID, {}, deps),
    /exceeded \d+ sequence_number race retries/,
  );
  assert.equal(calls.rpcCalls.length, MAX_SEQUENCE_RACE_RETRIES);
});

test("publishTierA — non-race RPC errors propagate without retry", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({
    rpcOutcomes: [
      new Error(
        "operator_publish_tier_a_lesson: origin foo does not match local self bar",
      ),
    ],
  });
  await assert.rejects(
    svc.publishTierA(FAKE_LESSON_ID, {}, deps),
    /does not match local self/,
  );
  assert.equal(calls.rpcCalls.length, 1);
});

test("publishTierA — rejects when local lesson row does not exist", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({ row: null });
  await assert.rejects(
    svc.publishTierA(FAKE_LESSON_ID, {}, deps),
    /not found/,
  );
  assert.equal(calls.signs, 0);
  assert.equal(calls.rpcCalls.length, 0);
});

test("publishTierA — rejects when node identity is not bootstrapped", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  const { deps, calls } = makeDeps({ self: null });
  await assert.rejects(
    svc.publishTierA(FAKE_LESSON_ID, {}, deps),
    /not bootstrapped/,
  );
  assert.equal(calls.signs, 0);
  assert.equal(calls.rpcCalls.length, 0);
});

test("publishTierA — applies caller's spec_version override", async () => {
  // The override flows into the unsigned envelope — receivers see "2.0".
  // We can't peek the envelope directly, but the RPC call captures the
  // signature input chain. Instead pin via a deps-side spy that records
  // the spec_version. Easiest: assert default vs override behavior by
  // inspecting the RPC args via a custom dep.
  const svc = new SwarmPublishService("http://stub", "stub");
  let captured = "";
  const baseDeps = makeDeps({
    rpcOutcomes: [
      {
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        origin_node_id: FAKE_NODE_ID,
        lesson_tier: "A",
        sequence_number: 0,
        lesson_hash: "z",
        audit_reason: "tool-publish",
        signed_at: "2026-05-01T12:34:56.000Z",
        received_at: "2026-05-01T12:34:56.000Z",
      },
    ],
  }).deps;
  const deps: SwarmPublishDeps = {
    ...baseDeps,
    async callOperatorPublishTierA(args) {
      captured = args.spec_version;
      return baseDeps.callOperatorPublishTierA(args);
    },
  };
  await svc.publishTierA(FAKE_LESSON_ID, { spec_version: "9.9" }, deps);
  assert.equal(captured, "9.9");
});

test("publishTierA — defaults spec_version to DEFAULT_SPEC_VERSION when caller omits", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  let captured = "";
  const baseDeps = makeDeps({
    rpcOutcomes: [
      {
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        origin_node_id: FAKE_NODE_ID,
        lesson_tier: "A",
        sequence_number: 0,
        lesson_hash: "z",
        audit_reason: "tool-publish",
        signed_at: "2026-05-01T12:34:56.000Z",
        received_at: "2026-05-01T12:34:56.000Z",
      },
    ],
  }).deps;
  const deps: SwarmPublishDeps = {
    ...baseDeps,
    async callOperatorPublishTierA(args) {
      captured = args.spec_version;
      return baseDeps.callOperatorPublishTierA(args);
    },
  };
  await svc.publishTierA(FAKE_LESSON_ID, {}, deps);
  assert.equal(captured, DEFAULT_SPEC_VERSION);
});

test("publishTierA — threads caller note into RPC audit_note arg", async () => {
  const svc = new SwarmPublishService("http://stub", "stub");
  let capturedNote: string | null = "<unset>";
  const baseDeps = makeDeps({
    rpcOutcomes: [
      {
        ok: true,
        status: "published",
        lesson_id: FAKE_LESSON_ID,
        origin_node_id: FAKE_NODE_ID,
        lesson_tier: "A",
        sequence_number: 0,
        lesson_hash: "z",
        audit_reason: "tool-publish: matched against local logbook",
        signed_at: "2026-05-01T12:34:56.000Z",
        received_at: "2026-05-01T12:34:56.000Z",
      },
    ],
  }).deps;
  const deps: SwarmPublishDeps = {
    ...baseDeps,
    async callOperatorPublishTierA(args) {
      capturedNote = args.audit_note;
      return baseDeps.callOperatorPublishTierA(args);
    },
  };
  await svc.publishTierA(
    FAKE_LESSON_ID,
    { note: "matched against local logbook" },
    deps,
  );
  assert.equal(capturedNote, "matched against local logbook");
});

// ---------------------------------------------------------------------------
// (7) MCP tool: ethics-gate + Zod schema
// ---------------------------------------------------------------------------

test("swarmPublishTierAlesson refuses when OPENCLAW_ALLOW_SWARM_WRITE is unset", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  try {
    const stubPub = {} as unknown as SwarmPublishService;
    const stubMem = {} as unknown as Parameters<
      typeof swarmPublishTierAlesson
    >[1];
    const out = await swarmPublishTierAlesson(stubPub, stubMem, {
      lesson_id: FAKE_LESSON_ID,
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
    assert.ok(out.fix_hint, "structured error must carry a fix_hint");
  } finally {
    if (original !== undefined)
      process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmPublishTierAlesson refuses with non-'1' env values (only '1' opens the gate)", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "true"; // truthy but not '1'
  try {
    const stubPub = {} as unknown as SwarmPublishService;
    const stubMem = {} as unknown as Parameters<
      typeof swarmPublishTierAlesson
    >[1];
    const out = await swarmPublishTierAlesson(stubPub, stubMem, {
      lesson_id: FAKE_LESSON_ID,
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
  } finally {
    if (original === undefined)
      delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmPublishTierAlessonSchema rejects malformed UUIDs", () => {
  const bad = swarmPublishTierAlessonSchema.safeParse({
    lesson_id: "not-a-uuid",
  });
  assert.equal(bad.success, false);

  const ok = swarmPublishTierAlessonSchema.safeParse({
    lesson_id: FAKE_LESSON_ID,
  });
  assert.equal(ok.success, true);
});

test("swarmPublishTierAlessonSchema accepts optional spec_version + note within bounds", () => {
  const ok = swarmPublishTierAlessonSchema.safeParse({
    lesson_id: FAKE_LESSON_ID,
    spec_version: "1.1",
    note: "smoke test",
  });
  assert.equal(ok.success, true);
});

test("swarmPublishTierAlessonSchema rejects oversize note (>480 chars)", () => {
  const bad = swarmPublishTierAlessonSchema.safeParse({
    lesson_id: FAKE_LESSON_ID,
    note: "x".repeat(500),
  });
  assert.equal(bad.success, false);
});
