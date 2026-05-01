import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SwarmResolveContradictService,
  isValidDecision,
  parseResolveOutcome,
  type ResolveContradictDecision,
  type SwarmResolveContradictDeps,
} from "../services/swarm-resolve-contradict.js";
import {
  swarmResolveContradict,
  swarmResolveContradictSchema,
} from "../tools/swarm-resolve-contradict.js";

// ---------------------------------------------------------------------------
// swarm_resolve_contradict — second write-side slice of issue #143
//
// Covers four contracts the §10.3 operator-decision branch depends on:
//   1. isValidDecision narrows the union before dispatch and rejects non-
//      whitelist values BEFORE the RPC call, so postgrest's RAISE EXCEPTION
//      text never leaks into the MCP caller's structured error.
//   2. parseResolveOutcome maps the JSONB shape from migration 086's RPC
//      onto the discriminated union — both branches (a/b vs park) — and
//      throws on shape drift so a future migration edit fails loud.
//   3. SwarmResolveContradictService.resolveContradict surfaces unknown
//      pair / already-resolved RPC errors verbatim so the tool can map
//      them to actionable fix_hints.
//   4. The MCP tool's ethics-gate refuses without
//      OPENCLAW_ALLOW_SWARM_WRITE=1 (mirrors swarm_pin_lesson).
// ---------------------------------------------------------------------------

const FAKE_PAIR_ID = "11111111-2222-3333-4444-555555555555";
const FAKE_KEPT_ID = "22222222-3333-4444-5555-666666666666";
const FAKE_DROPPED_ID = "33333333-4444-5555-6666-777777777777";

// ---------------------------------------------------------------------------
// (1) isValidDecision
// ---------------------------------------------------------------------------

test("isValidDecision accepts the three §10.3 outcomes", () => {
  assert.equal(isValidDecision("a"), true);
  assert.equal(isValidDecision("b"), true);
  assert.equal(isValidDecision("park"), true);
});

test("isValidDecision rejects everything else", () => {
  assert.equal(isValidDecision("c"), false);
  assert.equal(isValidDecision("A"), false); // case-sensitive
  assert.equal(isValidDecision(""), false);
  assert.equal(isValidDecision("rem-falsified"), false);
});

// ---------------------------------------------------------------------------
// (2) parseResolveOutcome
// ---------------------------------------------------------------------------

test("parseResolveOutcome maps an a-branch RPC body onto the keep variant", () => {
  const out = parseResolveOutcome({
    ok: true,
    pair_id: FAKE_PAIR_ID,
    decision: "a",
    kept_id: FAKE_KEPT_ID,
    dropped_id: FAKE_DROPPED_ID,
    resolved_at: "2026-05-01T17:00:00Z",
    promoted_to_a: true,
  });
  if (out.decision !== "a") {
    assert.fail(`expected decision='a', got ${out.decision}`);
  }
  assert.equal(out.kept_id, FAKE_KEPT_ID);
  assert.equal(out.dropped_id, FAKE_DROPPED_ID);
  assert.equal(out.promoted_to_a, true);
});

test("parseResolveOutcome maps a b-branch RPC body onto the keep variant", () => {
  const out = parseResolveOutcome({
    ok: true,
    pair_id: FAKE_PAIR_ID,
    decision: "b",
    kept_id: FAKE_KEPT_ID,
    dropped_id: FAKE_DROPPED_ID,
    resolved_at: "2026-05-01T17:00:00Z",
    promoted_to_a: false,
  });
  if (out.decision !== "b") {
    assert.fail(`expected decision='b', got ${out.decision}`);
  }
  assert.equal(out.promoted_to_a, false, "kept lesson was already at A");
});

test("parseResolveOutcome maps a park-branch RPC body onto the park variant", () => {
  const out = parseResolveOutcome({
    ok: true,
    pair_id: FAKE_PAIR_ID,
    decision: "park",
    a_id: FAKE_KEPT_ID,
    b_id: FAKE_DROPPED_ID,
    resolved_at: "2026-05-01T17:00:00Z",
  });
  assert.equal(out.decision, "park");
  if (out.decision !== "park") {
    assert.fail("expected park variant");
  }
  assert.equal(out.a_id, FAKE_KEPT_ID);
  assert.equal(out.b_id, FAKE_DROPPED_ID);
});

test("parseResolveOutcome throws on ok=false", () => {
  assert.throws(
    () =>
      parseResolveOutcome({
        ok: false,
        pair_id: FAKE_PAIR_ID,
        decision: "a",
      }),
    /ok=false/,
  );
});

test("parseResolveOutcome throws on shape drift (missing kept_id on a/b)", () => {
  // A future migration edit that drops kept_id from the RPC body would
  // silently feed undefined into the memory-bus side-effect. We want a
  // loud failure instead.
  assert.throws(
    () =>
      parseResolveOutcome({
        ok: true,
        pair_id: FAKE_PAIR_ID,
        decision: "a",
        // kept_id missing
        dropped_id: FAKE_DROPPED_ID,
        resolved_at: "2026-05-01T17:00:00Z",
      }),
    /missing kept_id/,
  );
});

test("parseResolveOutcome throws on non-object input", () => {
  assert.throws(() => parseResolveOutcome(null), /expected JSONB object/);
  assert.throws(() => parseResolveOutcome("a"), /expected JSONB object/);
  assert.throws(() => parseResolveOutcome([1, 2]), /expected JSONB object/);
});

test("parseResolveOutcome throws on unknown decision value", () => {
  assert.throws(
    () =>
      parseResolveOutcome({
        ok: true,
        pair_id: FAKE_PAIR_ID,
        decision: "rem-falsified",
        resolved_at: "2026-05-01T17:00:00Z",
      }),
    /decision must be a\/b\/park/,
  );
});

// ---------------------------------------------------------------------------
// (3) SwarmResolveContradictService.resolveContradict — orchestration
// ---------------------------------------------------------------------------

interface RecordedCalls {
  invoked: Array<{ pairId: string; decision: ResolveContradictDecision }>;
}

function makeDeps(
  responseOrError: unknown | Error,
): { deps: SwarmResolveContradictDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = { invoked: [] };
  const deps: SwarmResolveContradictDeps = {
    async callOperatorResolveContradict(pairId, decision) {
      calls.invoked.push({ pairId, decision });
      if (responseOrError instanceof Error) throw responseOrError;
      return responseOrError;
    },
  };
  return { deps, calls };
}

test("resolveContradict dispatches a-decision and parses the keep response", async () => {
  const svc = new SwarmResolveContradictService("http://stub", "stub");
  const { deps, calls } = makeDeps({
    ok: true,
    pair_id: FAKE_PAIR_ID,
    decision: "a",
    kept_id: FAKE_KEPT_ID,
    dropped_id: FAKE_DROPPED_ID,
    resolved_at: "2026-05-01T17:00:00Z",
    promoted_to_a: true,
  });

  const out = await svc.resolveContradict(FAKE_PAIR_ID, "a", deps);
  assert.equal(out.decision, "a");
  assert.equal(out.pair_id, FAKE_PAIR_ID);
  assert.equal(calls.invoked.length, 1);
  assert.deepEqual(calls.invoked[0], {
    pairId: FAKE_PAIR_ID,
    decision: "a",
  });
});

test("resolveContradict rejects an invalid decision BEFORE the RPC dispatch", async () => {
  const svc = new SwarmResolveContradictService("http://stub", "stub");
  const { deps, calls } = makeDeps({});
  await assert.rejects(
    svc.resolveContradict(
      FAKE_PAIR_ID,
      "rem-falsified" as ResolveContradictDecision,
      deps,
    ),
    /decision must be a\/b\/park/i,
  );
  // CRITICAL: dispatch must NOT happen — postgrest's exception text would
  // leak through and the MCP caller's structured error would lose the
  // typed reason.
  assert.equal(calls.invoked.length, 0, "RPC must not be called for invalid decision");
});

test("resolveContradict surfaces unknown-pair RPC errors verbatim", async () => {
  const svc = new SwarmResolveContradictService("http://stub", "stub");
  const { deps } = makeDeps(
    new Error(
      "operator_resolve_contradict RPC failed: operator_resolve_contradict: unknown pair_id 11111111-2222-3333-4444-555555555555",
    ),
  );
  await assert.rejects(
    svc.resolveContradict(FAKE_PAIR_ID, "a", deps),
    /unknown pair_id/i,
  );
});

test("resolveContradict surfaces already-resolved errors with the original timestamp", async () => {
  const svc = new SwarmResolveContradictService("http://stub", "stub");
  const { deps } = makeDeps(
    new Error(
      "operator_resolve_contradict RPC failed: operator_resolve_contradict: pair 11111111-2222-3333-4444-555555555555 already resolved at 2026-05-01T16:00:00Z",
    ),
  );
  await assert.rejects(
    svc.resolveContradict(FAKE_PAIR_ID, "park", deps),
    /already resolved at 2026-05-01T16:00:00Z/i,
  );
});

// ---------------------------------------------------------------------------
// (4) MCP tool: ethics-gate + Zod schema
// ---------------------------------------------------------------------------

test("swarmResolveContradict refuses when OPENCLAW_ALLOW_SWARM_WRITE is unset", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  try {
    const stubSvc = {} as unknown as SwarmResolveContradictService;
    const stubMem = {} as unknown as Parameters<
      typeof swarmResolveContradict
    >[1];
    const out = await swarmResolveContradict(stubSvc, stubMem, {
      pair_id: FAKE_PAIR_ID,
      decision: "a",
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
    assert.ok(out.fix_hint, "structured error must carry a fix_hint");
  } finally {
    if (original !== undefined)
      process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmResolveContradict refuses with non-'1' env values", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "true";
  try {
    const stubSvc = {} as unknown as SwarmResolveContradictService;
    const stubMem = {} as unknown as Parameters<
      typeof swarmResolveContradict
    >[1];
    const out = await swarmResolveContradict(stubSvc, stubMem, {
      pair_id: FAKE_PAIR_ID,
      decision: "park",
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmResolveContradict surfaces unknown-pair errors with a precise fix_hint", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    // Build a real service with a deps stub that throws unknown-pair.
    const svc = new SwarmResolveContradictService("http://stub", "stub");
    const failingDeps: SwarmResolveContradictDeps = {
      async callOperatorResolveContradict() {
        throw new Error(
          "operator_resolve_contradict RPC failed: operator_resolve_contradict: unknown pair_id ...",
        );
      },
    };
    // Override defaultDeps so the tool's call to service.defaultDeps()
    // hands the stub back. Service-level test is enough to verify wiring;
    // this exercises the tool's error mapping.
    (svc as unknown as { defaultDeps: () => SwarmResolveContradictDeps }).defaultDeps =
      () => failingDeps;
    const stubMem = {} as unknown as Parameters<
      typeof swarmResolveContradict
    >[1];
    const out = await swarmResolveContradict(svc, stubMem, {
      pair_id: FAKE_PAIR_ID,
      decision: "a",
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /unknown pair_id/);
    assert.match(out.fix_hint ?? "", /swarm_lesson_contradictions/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmResolveContradict writes a memory row on success (best-effort)", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const svc = new SwarmResolveContradictService("http://stub", "stub");
    (svc as unknown as { defaultDeps: () => SwarmResolveContradictDeps }).defaultDeps =
      () => ({
        async callOperatorResolveContradict() {
          return {
            ok: true,
            pair_id: FAKE_PAIR_ID,
            decision: "a",
            kept_id: FAKE_KEPT_ID,
            dropped_id: FAKE_DROPPED_ID,
            resolved_at: "2026-05-01T17:00:00Z",
            promoted_to_a: true,
          };
        },
      });

    const memoryCalls: Array<Record<string, unknown>> = [];
    const memStub = {
      async create(input: Record<string, unknown>) {
        memoryCalls.push(input);
      },
    } as unknown as Parameters<typeof swarmResolveContradict>[1];

    const out = await swarmResolveContradict(svc, memStub, {
      pair_id: FAKE_PAIR_ID,
      decision: "a",
    });
    assert.equal(out.ok, true);
    assert.equal(out.memory_recorded, true);
    assert.equal(memoryCalls.length, 1);
    assert.equal(memoryCalls[0].category, "decisions");
    const tags = memoryCalls[0].tags as string[];
    assert.ok(tags.includes("swarm"));
    assert.ok(tags.includes("contradict-resolved"));
    assert.ok(tags.includes("decision-a"));
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmResolveContradict succeeds even when memory-bus write fails (best-effort contract)", async () => {
  // §10.6 + §10.3 traceability: the durable record is the RPC's audit row
  // in tier_promotion_log + the resolved_at stamp in
  // swarm_lesson_contradictions. The memory-bus row is a recall convenience —
  // if the embedding provider is down, the resolve must still succeed.
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "1";
  try {
    const svc = new SwarmResolveContradictService("http://stub", "stub");
    (svc as unknown as { defaultDeps: () => SwarmResolveContradictDeps }).defaultDeps =
      () => ({
        async callOperatorResolveContradict() {
          return {
            ok: true,
            pair_id: FAKE_PAIR_ID,
            decision: "park",
            a_id: FAKE_KEPT_ID,
            b_id: FAKE_DROPPED_ID,
            resolved_at: "2026-05-01T17:00:00Z",
          };
        },
      });

    const memStub = {
      async create() {
        throw new Error("embedding-provider-down");
      },
    } as unknown as Parameters<typeof swarmResolveContradict>[1];

    const out = await swarmResolveContradict(svc, memStub, {
      pair_id: FAKE_PAIR_ID,
      decision: "park",
    });
    assert.equal(out.ok, true, "resolve must still report ok=true");
    assert.equal(out.memory_recorded, false);
    assert.match(out.memory_error ?? "", /embedding-provider-down/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmResolveContradictSchema rejects malformed UUIDs and out-of-range decisions", () => {
  const bad1 = swarmResolveContradictSchema.safeParse({
    pair_id: "not-a-uuid",
    decision: "a",
  });
  assert.equal(bad1.success, false);

  const bad2 = swarmResolveContradictSchema.safeParse({
    pair_id: FAKE_PAIR_ID,
    decision: "rem-falsified",
  });
  assert.equal(bad2.success, false);

  const ok = swarmResolveContradictSchema.safeParse({
    pair_id: FAKE_PAIR_ID,
    decision: "park",
  });
  assert.equal(ok.success, true);
});
