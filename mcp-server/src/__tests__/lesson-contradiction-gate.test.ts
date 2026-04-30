import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COSINE_TOPIC_THRESHOLD,
  applyContradictionGate,
  classifyPolarity,
  cosineSimilarity,
  detectContradictionsAgainst,
  polarityInverted,
  type ApplyDeps,
  type SwarmLessonRow,
} from "../services/lesson-contradiction-gate.js";

// ---------------------------------------------------------------------------
// lesson-contradiction-gate — Swarm Phase 4g (issue #108)
//
// Covers four contracts that the §10.3 receiver-side gate depends on:
//   1. cosineSimilarity is mathematically correct AND defensive on
//      degenerate input (zero vectors / dim mismatch return 0, not NaN).
//   2. The bilingual negation-token heuristic in classifyPolarity behaves
//      symmetrically across en/de inputs and treats two negations as
//      `negated` (no double-negation cancellation).
//   3. detectContradictionsAgainst returns a finding ONLY when cosine
//      strictly exceeds 0.85 AND polarity is inverted; same-polarity
//      high-cosine pairs are corroboration and MUST NOT be flagged.
//   4. applyContradictionGate orchestrates persistence + experience
//      logging without throwing the whole batch on a single per-row
//      failure (per-finding error boundary).
// ---------------------------------------------------------------------------

// Helper: produce a 768-dim unit vector pointing along axis `i`. Two such
// vectors are orthogonal (cosine 0); a small linear combination is a
// near-neighbour with controllable cosine.
function unitAxis(i: number): number[] {
  const v = new Array<number>(768).fill(0);
  v[i % 768] = 1;
  return v;
}

function blend(a: number[], b: number[], wA: number): number[] {
  // Linear blend; result is NOT renormalised so callers can probe the
  // cosine via the formula directly.
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = wA * a[i] + (1 - wA) * b[i];
  return out;
}

// ---------------------------------------------------------------------------
// (1) cosineSimilarity
// ---------------------------------------------------------------------------

test("cosineSimilarity returns 1 for identical vectors", () => {
  const v = unitAxis(7);
  assert.equal(cosineSimilarity(v, v), 1);
});

test("cosineSimilarity returns 0 for orthogonal vectors", () => {
  assert.equal(cosineSimilarity(unitAxis(0), unitAxis(1)), 0);
});

test("cosineSimilarity returns -1 for opposite vectors", () => {
  const a = unitAxis(0);
  const b = a.map((x) => -x);
  assert.equal(cosineSimilarity(a, b), -1);
});

test("cosineSimilarity returns 0 on zero-vector (defensive, no NaN)", () => {
  // A zero vector has undefined cosine. Returning 0 lets the threshold
  // gate (`> 0.85`) safely reject it without a special-case branch in
  // the orchestrator.
  const z = new Array<number>(768).fill(0);
  assert.equal(cosineSimilarity(z, unitAxis(0)), 0);
  assert.equal(cosineSimilarity(unitAxis(0), z), 0);
});

test("cosineSimilarity returns 0 on length mismatch (defensive)", () => {
  // Embedding-dim drift across producers should be caught upstream by
  // the wire-validator (rule 4), but if a legacy row sneaks in, returning
  // 0 keeps the gate from comparing apples to oranges.
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0);
});

test("cosineSimilarity returns 0 if any element is non-finite (NaN/Infinity)", () => {
  const a = unitAxis(0);
  const bad = unitAxis(0).map((x, i) => (i === 0 ? NaN : x));
  assert.equal(cosineSimilarity(a, bad), 0);
  const inf = unitAxis(0).map((x, i) => (i === 0 ? Infinity : x));
  assert.equal(cosineSimilarity(a, inf), 0);
});

test("cosineSimilarity returns 0 on non-array input", () => {
  // Defensive against accidental JSONB-to-undefined readback.
  assert.equal(cosineSimilarity(null as unknown as number[], unitAxis(0)), 0);
  assert.equal(cosineSimilarity(unitAxis(0), undefined as unknown as number[]), 0);
});

// ---------------------------------------------------------------------------
// (2) classifyPolarity / polarityInverted
// ---------------------------------------------------------------------------

test("classifyPolarity returns 'affirmed' on a positive English claim", () => {
  assert.equal(
    classifyPolarity("Always sign Lesson records before broadcast."),
    "affirmed",
  );
});

test("classifyPolarity detects English hard-negation tokens", () => {
  assert.equal(classifyPolarity("Do not sign Lesson records yet."), "negated");
  assert.equal(classifyPolarity("Lesson records must never leave unsigned."), "negated");
  assert.equal(classifyPolarity("We can't trust the gateway here."), "negated");
  assert.equal(classifyPolarity("This MUST NOT be re-broadcast."), "negated");
});

test("classifyPolarity detects German hard-negation tokens", () => {
  // The bilingual coverage matters: most lessons in this repo are
  // mixed en/de. A monolingual heuristic would miss half of them.
  assert.equal(classifyPolarity("Lessons sind niemals roh zu versenden."), "negated");
  assert.equal(classifyPolarity("Wir dürfen kein Memory-Backend ohne Auth ausliefern."), "negated");
  assert.equal(classifyPolarity("Das darf nicht im public Repo landen."), "negated");
});

test("classifyPolarity treats two negations as 'negated' (no double-negation cancellation)", () => {
  // Documented in the polarity write-up: two negations amplify, not
  // cancel. Real-world double negations are rare in technical lessons
  // and tend to be emphatic ("never not signed"), not affirming.
  assert.equal(
    classifyPolarity("never trust an unsigned lesson, no exceptions"),
    "negated",
  );
});

test("classifyPolarity is empty-input safe (returns 'affirmed')", () => {
  // The orchestrator may call us before content is fully populated.
  // Returning 'affirmed' on empty makes the inversion check a no-op
  // by default rather than producing spurious findings.
  assert.equal(classifyPolarity(""), "affirmed");
  assert.equal(classifyPolarity("   "), "affirmed");
  assert.equal(classifyPolarity(null as unknown as string), "affirmed");
});

test("polarityInverted is true ONLY on (negated, affirmed) pairs", () => {
  assert.equal(polarityInverted("negated", "affirmed"), true);
  assert.equal(polarityInverted("affirmed", "negated"), true);
  assert.equal(polarityInverted("negated", "negated"), false);
  assert.equal(polarityInverted("affirmed", "affirmed"), false);
  // Mixed never triggers — corroboration / ambiguity is NOT contradiction.
  assert.equal(polarityInverted("mixed", "negated"), false);
  assert.equal(polarityInverted("affirmed", "mixed"), false);
  assert.equal(polarityInverted("mixed", "mixed"), false);
});

// ---------------------------------------------------------------------------
// (3) detectContradictionsAgainst
// ---------------------------------------------------------------------------

test("detectContradictionsAgainst flags a high-cosine + polarity-inverted pair", () => {
  const a = unitAxis(3);
  // Near-identical embedding (cosine ~= 1).
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Do not sign Lesson records before broadcast.",
    embedding: a.slice(),
  };
  const findings = detectContradictionsAgainst(incoming, [prior]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].new_lesson_id,   incoming.id);
  assert.equal(findings[0].prior_lesson_id, prior.id);
  assert.ok(findings[0].cosine > COSINE_TOPIC_THRESHOLD,
    `expected cosine > ${COSINE_TOPIC_THRESHOLD}, got ${findings[0].cosine}`);
  assert.equal(findings[0].confidence, findings[0].cosine);
  assert.match(findings[0].reason, /polarity inversion/);
});

test("detectContradictionsAgainst ignores high-cosine SAME-polarity pairs (corroboration)", () => {
  // §10.3 is explicit: "if there is no contradiction, do not flag".
  // Two affirmed claims about the same topic are corroboration; flagging
  // them would amplify echo-chamber risk, the inverse of what 4g exists for.
  const a = unitAxis(5);
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Always sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Lesson records should be signed before broadcast.",
    embedding: a.slice(),
  };
  const findings = detectContradictionsAgainst(incoming, [prior]);
  assert.equal(findings.length, 0);
});

test("detectContradictionsAgainst ignores low-cosine pairs even with polarity inversion", () => {
  // Two unrelated topics that happen to have opposite polarity are NOT
  // contradicting each other. The cosine gate filters out cross-topic
  // noise so the polarity heuristic only fires on genuine same-topic pairs.
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Sign Lesson records before broadcast.",
    embedding: unitAxis(0),
  };
  const prior: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Do not crash the Supabase container during migrations.",
    embedding: unitAxis(123),    // orthogonal — cosine = 0
  };
  const findings = detectContradictionsAgainst(incoming, [prior]);
  assert.equal(findings.length, 0);
});

test("detectContradictionsAgainst rejects exactly-at-threshold cosine (strict >, not >=)", () => {
  // §10.3 says "cosine > 0.85" — a strict inequality. Pin that we don't
  // accidentally use >=, which would leak in pairs that are right at
  // the noise floor of the embedding model.
  const a = unitAxis(0);
  const b = unitAxis(1);
  // Construct vectors with a known cosine. With unit axes this is the
  // dot product divided by the product of norms. We blend so cos(out, a)
  // is exactly the blend weight on a (approximately).
  const exactly: number[] = [];
  // Build a vector v such that cos(v, a) == 0.85 exactly.
  // v = 0.85 * a + sqrt(1 - 0.85^2) * b → norm 1, dot a = 0.85.
  const wA = 0.85;
  const wB = Math.sqrt(1 - wA * wA);
  for (let i = 0; i < a.length; i++) exactly.push(wA * a[i] + wB * b[i]);

  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Do not sign Lesson records before broadcast.",
    embedding: exactly,
  };
  const findings = detectContradictionsAgainst(incoming, [prior]);
  assert.equal(findings.length, 0,
    "cosine == 0.85 must NOT trigger the gate; only cosine > 0.85 does");
});

test("detectContradictionsAgainst silently skips self-pairs", () => {
  // Re-ingesting the same row should not flag it as contradicting itself.
  // This is also the only place that prevents the orchestrator from
  // creating an a_id == b_id row, which the table CHECK would reject.
  const a = unitAxis(2);
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Do not sign Lesson records yet.",
    embedding: a,
  };
  const findings = detectContradictionsAgainst(incoming, [incoming]);
  assert.equal(findings.length, 0);
});

test("detectContradictionsAgainst handles multiple priors and returns one finding per contradiction", () => {
  const a = unitAxis(11);
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const priors: SwarmLessonRow[] = [
    { id: "22222222-2222-2222-2222-222222222222", content: "Do not sign Lesson records before broadcast.",      embedding: a.slice() },
    { id: "33333333-3333-3333-3333-333333333333", content: "Sign Lesson records before broadcast.",            embedding: a.slice() },     // corroboration
    { id: "44444444-4444-4444-4444-444444444444", content: "Do not crash the Supabase container.",             embedding: unitAxis(456) }, // unrelated
    { id: "55555555-5555-5555-5555-555555555555", content: "Lesson signing must never be skipped under load.", embedding: a.slice() },     // corroboration (same polarity actually 'negated' too — see note)
  ];
  const findings = detectContradictionsAgainst(incoming, priors);
  // Only #2 contradicts #1. #3 corroborates (same polarity). #4 is
  // unrelated (low cosine). #5 also has 'never' so it's classified
  // 'negated', which is OPPOSITE polarity to incoming's 'affirmed' —
  // so #5 is also flagged as a contradiction. Net: 2 findings.
  // This is intentional: the heuristic conservatively flags both, and
  // §10.5 REM-audit can later corroborate #5 against local experience.
  assert.equal(findings.length, 2);
  const ids = findings.map((f) => f.prior_lesson_id).sort();
  assert.deepEqual(ids, [
    "22222222-2222-2222-2222-222222222222",
    "55555555-5555-5555-5555-555555555555",
  ]);
});

test("detectContradictionsAgainst returns [] when incoming embedding is missing", () => {
  // Defensive — a malformed row should produce no false positives.
  const incoming: SwarmLessonRow = {
    id:        "11111111-1111-1111-1111-111111111111",
    content:   "Do not sign.",
    embedding: [],
  };
  const prior: SwarmLessonRow = {
    id:        "22222222-2222-2222-2222-222222222222",
    content:   "Sign always.",
    embedding: unitAxis(0),
  };
  assert.equal(detectContradictionsAgainst(incoming, [prior]).length, 0);
});

// ---------------------------------------------------------------------------
// (4) applyContradictionGate (orchestrator)
// ---------------------------------------------------------------------------

function makeRecorder() {
  const calls: Array<{ a_id: string; b_id: string; cosine: number; confidence: number; reason: string }> = [];
  const fn: ApplyDeps["recordContradiction"] = async (args) => {
    calls.push(args);
    return { ok: true, id: "edge-" + (calls.length), ...args };
  };
  return { calls, fn };
}

function makeExperienceRecorder() {
  const calls: Array<{ summary: string; tags: string[]; metadata: Record<string, unknown> }> = [];
  const fn: NonNullable<ApplyDeps["recordExperience"]> = async (args) => {
    calls.push(args);
  };
  return { calls, fn };
}

test("applyContradictionGate persists every finding via recordContradiction", async () => {
  const a = unitAxis(7);
  const incoming: SwarmLessonRow = {
    id:        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    content:   "Do not sign Lesson records before broadcast.",
    embedding: a.slice(),
  };
  const rec = makeRecorder();
  const res = await applyContradictionGate(incoming, [prior], { recordContradiction: rec.fn });
  assert.equal(res.findings.length, 1);
  assert.equal(res.edges_recorded, 1);
  assert.equal(rec.calls.length, 1);
  assert.equal(rec.calls[0].a_id, incoming.id);
  assert.equal(rec.calls[0].b_id, prior.id);
});

test("applyContradictionGate does NOT call recordContradiction when there are no findings", async () => {
  const incoming: SwarmLessonRow = {
    id:        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    content:   "Sign Lesson records before broadcast.",
    embedding: unitAxis(0),
  };
  const prior: SwarmLessonRow = {
    id:        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    content:   "Lesson records should be signed before broadcast.",
    embedding: unitAxis(0),
  };
  const rec = makeRecorder();
  const res = await applyContradictionGate(incoming, [prior], { recordContradiction: rec.fn });
  assert.equal(res.findings.length, 0);
  assert.equal(res.edges_recorded, 0);
  assert.equal(rec.calls.length, 0);
});

test("applyContradictionGate isolates per-finding failures (one bad row doesn't poison the batch)", async () => {
  // Build TWO independent contradictions.
  const a = unitAxis(7);
  const incoming: SwarmLessonRow = {
    id:        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const priors: SwarmLessonRow[] = [
    { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", content: "Do not sign Lesson records before broadcast.", embedding: a.slice() },
    { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", content: "Lesson records must never be signed.",         embedding: a.slice() },
  ];
  let n = 0;
  const recorder: ApplyDeps["recordContradiction"] = async () => {
    n += 1;
    if (n === 1) throw new Error("simulated DB transient");
    return { ok: true };
  };
  const res = await applyContradictionGate(incoming, priors, { recordContradiction: recorder });
  assert.equal(res.findings.length, 2,        "detector still finds both contradictions");
  assert.equal(res.edges_recorded, 1,         "second finding still persists despite first throwing");
});

test("applyContradictionGate calls recordExperience when provided + tags include phase-4g marker", async () => {
  // The experience-tag is the breadcrumb 4h's REM self-audit will
  // search for when revisiting tentative lessons. Pin it explicitly.
  const a = unitAxis(9);
  const incoming: SwarmLessonRow = {
    id:        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    content:   "Do not sign Lesson records before broadcast.",
    embedding: a.slice(),
  };
  const rec = makeRecorder();
  const exp = makeExperienceRecorder();
  const res = await applyContradictionGate(incoming, [prior], {
    recordContradiction: rec.fn,
    recordExperience:    exp.fn,
  });
  assert.equal(res.experiences_logged, 1);
  assert.equal(exp.calls.length, 1);
  assert.ok(exp.calls[0].tags.includes("phase-4g"),    "phase-4g tag is the REM-audit breadcrumb");
  assert.ok(exp.calls[0].tags.includes("contradiction"));
  assert.ok(exp.calls[0].tags.includes("swarm"));
  assert.equal(exp.calls[0].metadata.spec_section, "§10.3");
  assert.equal(exp.calls[0].metadata.new_lesson_id, incoming.id);
  assert.equal(exp.calls[0].metadata.prior_lesson_id, prior.id);
});

test("applyContradictionGate treats experience-recorder failure as non-fatal", async () => {
  // Edge persistence is load-bearing; experience logging is observability.
  // A failing experience-recorder MUST NOT mask the edge being persisted.
  const a = unitAxis(13);
  const incoming: SwarmLessonRow = {
    id:        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    content:   "Sign Lesson records before broadcast.",
    embedding: a,
  };
  const prior: SwarmLessonRow = {
    id:        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
    content:   "Do not sign Lesson records before broadcast.",
    embedding: a.slice(),
  };
  const rec = makeRecorder();
  const failingExp: ApplyDeps["recordExperience"] = async () => {
    throw new Error("simulated experience-store transient");
  };
  const res = await applyContradictionGate(incoming, [prior], {
    recordContradiction: rec.fn,
    recordExperience:    failingExp,
  });
  assert.equal(res.edges_recorded, 1,        "edge still persists when experience logging throws");
  assert.equal(res.experiences_logged, 0);
});
