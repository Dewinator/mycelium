import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SwarmPinService,
  buildPinReason,
  type LessonTier,
  type SwarmPinDeps,
} from "../services/swarm-pin.js";
import {
  swarmPinLesson,
  swarmPinLessonSchema,
} from "../tools/swarm-pin.js";

// ---------------------------------------------------------------------------
// swarm_pin_lesson — first write-side slice of issue #143
//
// Covers four contracts the §10.6 operator override depends on:
//   1. buildPinReason produces the 'operator-pinned' machine-readable prefix
//      and respects the migration-078 octet_length(reason) <= 512 bound,
//      including UTF-8 boundary safety on truncation.
//   2. SwarmPinService.pinLesson rejects no-op transitions BEFORE touching
//      the DB, so the audit log never sees a (from = to) row that the
//      migration-078 CHECK would reject anyway.
//   3. SwarmPinService.pinLesson writes the audit row BEFORE the tier
//      UPDATE — the §10.6 traceability contract requires every transition
//      attempt on the log even when the UPDATE later fails.
//   4. The MCP tool's ethics-gate refuses without
//      OPENCLAW_ALLOW_SWARM_WRITE=1, mirroring the OPENCLAW_ALLOW_BREEDING
//      pattern, and the Zod schema validates the UUID + tier inputs.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (1) buildPinReason
// ---------------------------------------------------------------------------

test("buildPinReason returns bare prefix when note is missing", () => {
  assert.equal(buildPinReason(), "operator-pinned");
  assert.equal(buildPinReason(undefined), "operator-pinned");
  assert.equal(buildPinReason(""), "operator-pinned");
  assert.equal(buildPinReason("   "), "operator-pinned");
});

test("buildPinReason embeds caller note after ': ' separator", () => {
  assert.equal(
    buildPinReason("manually corroborated against logbook"),
    "operator-pinned: manually corroborated against logbook",
  );
});

test("buildPinReason trims surrounding whitespace from caller note", () => {
  assert.equal(
    buildPinReason("   trimmed   "),
    "operator-pinned: trimmed",
  );
});

test("buildPinReason truncates oversize notes within the 512-octet budget", () => {
  // Build a note larger than the per-note budget. After buildPinReason
  // the full reason must still fit the migration-078 reason CHECK.
  const huge = "x".repeat(800);
  const out = buildPinReason(huge);
  // Exact char counts vary based on truncation strategy; the contract is
  // "stays under the migration-078 octet bound".
  assert.ok(
    Buffer.byteLength(out, "utf8") <= 512,
    `reason should fit 512 octets, got ${Buffer.byteLength(out, "utf8")}`,
  );
  assert.ok(out.startsWith("operator-pinned: "));
  // Truncation should leave an ellipsis to signal that data was cut.
  assert.ok(out.endsWith("…"), "truncated reason should end with ellipsis");
});

test("buildPinReason does NOT split a multi-byte UTF-8 codepoint", () => {
  // 4-byte emoji repeated until well past the budget. A naive byte-cut
  // would leave a half-codepoint at the end and Postgres would reject it.
  const emoji = "🌱"; // U+1F331, 4 bytes UTF-8
  const note = emoji.repeat(200); // 800 bytes
  const out = buildPinReason(note);
  // Round-tripping through Buffer should not throw; if we'd cut mid-codepoint,
  // the final char would be a replacement character rather than `…`.
  assert.ok(
    out.endsWith("…"),
    "ellipsis should appear at a clean codepoint boundary",
  );
  assert.ok(Buffer.byteLength(out, "utf8") <= 512);
});

// ---------------------------------------------------------------------------
// (2) SwarmPinService.pinLesson — orchestration
// ---------------------------------------------------------------------------

interface RecordedCalls {
  fetched:    string[];
  recorded:   Array<{ id: string; from: LessonTier; to: LessonTier; reason: string }>;
  updated:    Array<{ id: string; tier: LessonTier }>;
}

function makeDeps(
  initialTier: LessonTier | null,
  opts: { recordFails?: boolean; updateFails?: boolean } = {},
): { deps: SwarmPinDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = { fetched: [], recorded: [], updated: [] };
  const deps: SwarmPinDeps = {
    async fetchCurrentTier(id) {
      calls.fetched.push(id);
      return initialTier;
    },
    async recordTierTransition(id, from, to, reason) {
      calls.recorded.push({ id, from, to, reason });
      if (opts.recordFails) throw new Error("audit-log-down");
    },
    async updateLessonTier(id, tier) {
      calls.updated.push({ id, tier });
      if (opts.updateFails) throw new Error("update-down");
    },
  };
  return { deps, calls };
}

const FAKE_ID = "11111111-2222-3333-4444-555555555555";

test("pinLesson promotes B → A and writes the audit row first", async () => {
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps("B");
  const out = await svc.pinLesson(FAKE_ID, "A", undefined, deps);

  assert.deepEqual(out, {
    lesson_id: FAKE_ID,
    from_tier: "B",
    to_tier:   "A",
    reason:    "operator-pinned",
  });
  assert.deepEqual(calls.fetched, [FAKE_ID]);
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.recorded[0].from, "B");
  assert.equal(calls.recorded[0].to, "A");
  assert.equal(calls.updated.length, 1);
  assert.equal(calls.updated[0].tier, "A");
});

test("pinLesson demotes A → B and threads the caller note into the audit reason", async () => {
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps("A");
  const out = await svc.pinLesson(FAKE_ID, "B", "contested by local logs", deps);

  assert.equal(out.from_tier, "A");
  assert.equal(out.to_tier, "B");
  assert.equal(out.reason, "operator-pinned: contested by local logs");
  assert.equal(calls.recorded[0].reason, "operator-pinned: contested by local logs");
});

test("pinLesson rejects a no-op (current tier already equals target)", async () => {
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps("A");
  await assert.rejects(
    svc.pinLesson(FAKE_ID, "A", undefined, deps),
    /already at tier A/i,
  );
  // CRITICAL: the no-op rejection happens BEFORE any DB writes, so the
  // audit log is never polluted by would-be no-ops.
  assert.equal(calls.recorded.length, 0);
  assert.equal(calls.updated.length, 0);
});

test("pinLesson rejects when the lesson does not exist", async () => {
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps(null);
  await assert.rejects(
    svc.pinLesson(FAKE_ID, "A", undefined, deps),
    /not found/i,
  );
  assert.equal(calls.recorded.length, 0);
  assert.equal(calls.updated.length, 0);
});

test("pinLesson skips the tier UPDATE when the audit-log INSERT fails", async () => {
  // §10.6 traceability: losing the audit is worse than a stuck tier.
  // If the audit-log INSERT fails, the UPDATE must NOT run (otherwise we'd
  // have a silent transition that the operator cannot retrace).
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps("B", { recordFails: true });
  await assert.rejects(
    svc.pinLesson(FAKE_ID, "A", undefined, deps),
    /audit-log-down/,
  );
  assert.equal(calls.recorded.length, 1, "audit insert should be attempted");
  assert.equal(calls.updated.length, 0, "tier update must NOT run when audit failed");
});

test("pinLesson surfaces a failed UPDATE after the audit row is durable", async () => {
  // Symmetric: audit row IS in the log (durable transition record), but
  // the tier flip itself failed. Caller must see the error so they can
  // retry; the log entry now serves as the trail of the attempt.
  const svc = new SwarmPinService("http://stub", "stub");
  const { deps, calls } = makeDeps("B", { updateFails: true });
  await assert.rejects(
    svc.pinLesson(FAKE_ID, "A", undefined, deps),
    /update-down/,
  );
  assert.equal(calls.recorded.length, 1);
  assert.equal(calls.updated.length, 1);
});

// ---------------------------------------------------------------------------
// (3) MCP tool: ethics-gate + Zod schema
// ---------------------------------------------------------------------------

test("swarmPinLesson refuses when OPENCLAW_ALLOW_SWARM_WRITE is unset", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  try {
    const stubPin = {} as unknown as SwarmPinService;
    const stubMem = {} as unknown as Parameters<typeof swarmPinLesson>[1];
    const out = await swarmPinLesson(stubPin, stubMem, {
      lesson_id: FAKE_ID,
      tier: "A",
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
    assert.ok(out.fix_hint, "structured error must carry a fix_hint");
  } finally {
    if (original !== undefined) process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmPinLesson refuses with non-'1' env values (only '1' opens the gate)", async () => {
  const original = process.env.OPENCLAW_ALLOW_SWARM_WRITE;
  process.env.OPENCLAW_ALLOW_SWARM_WRITE = "true"; // truthy but not '1'
  try {
    const stubPin = {} as unknown as SwarmPinService;
    const stubMem = {} as unknown as Parameters<typeof swarmPinLesson>[1];
    const out = await swarmPinLesson(stubPin, stubMem, {
      lesson_id: FAKE_ID,
      tier: "A",
    });
    assert.equal(out.ok, false);
    assert.match(out.error ?? "", /OPENCLAW_ALLOW_SWARM_WRITE/);
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_ALLOW_SWARM_WRITE;
    else process.env.OPENCLAW_ALLOW_SWARM_WRITE = original;
  }
});

test("swarmPinLessonSchema rejects malformed UUIDs and out-of-range tiers", () => {
  // Zod's safeParse so we get the structured error rather than a throw.
  const bad1 = swarmPinLessonSchema.safeParse({
    lesson_id: "not-a-uuid",
    tier: "A",
  });
  assert.equal(bad1.success, false);

  const bad2 = swarmPinLessonSchema.safeParse({
    lesson_id: FAKE_ID,
    tier: "C", // out of enum
  });
  assert.equal(bad2.success, false);

  const ok = swarmPinLessonSchema.safeParse({
    lesson_id: FAKE_ID,
    tier: "A",
    reason: "x",
  });
  assert.equal(ok.success, true);
});
