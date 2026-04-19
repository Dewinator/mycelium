import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreEncoding } from "../services/heuristics.js";

test("neutral text stays near defaults", () => {
  const s = scoreEncoding("der himmel ist blau");
  assert.equal(s.importance, 0.5);
  assert.equal(s.valence, 0);
  assert.equal(s.arousal, 0);
});

test("important keywords raise importance", () => {
  const s = scoreEncoding("Wichtig: Deadline ist am 2026-05-01");
  assert.ok(s.importance > 0.7, `expected >0.7, got ${s.importance}`);
});

test("positive keywords raise valence", () => {
  const s = scoreEncoding("ich liebe diesen ansatz, super gelungen");
  assert.ok(s.valence > 0.3);
});

test("negative + intense raises arousal and lowers valence", () => {
  const s = scoreEncoding("DRINGEND: kritischer bug, sofort fixen!!!");
  assert.ok(s.arousal > 0.5, `expected arousal>0.5, got ${s.arousal}`);
  assert.ok(s.importance > 0.6);
});

test("clamps stay in range", () => {
  const s = scoreEncoding("WICHTIG WICHTIG WICHTIG sofort dringend extrem!!! 2026-01-01 100€");
  assert.ok(s.importance <= 1);
  assert.ok(s.arousal <= 1);
  assert.ok(s.valence <= 1 && s.valence >= -1);
});

// ---------------------------------------------------------------------------
// Ephemeral (one-time instruction) detection
// ---------------------------------------------------------------------------

test("ephemeral: German imperative to stop a cron job", () => {
  const s = scoreEncoding("stoppe den cron job backup-daily");
  assert.equal(s.ephemeral, true);
  assert.equal(s.importance, 0.1);
  assert.equal(s.decay_tau_days, 2);
});

test("ephemeral: English imperative to stop a cron job", () => {
  const s = scoreEncoding("stop the cron job backup-daily");
  assert.equal(s.ephemeral, true);
  assert.equal(s.importance, 0.1);
  assert.equal(s.decay_tau_days, 2);
});

test("ephemeral: past-tense action narration ('wir haben migration ausgeführt')", () => {
  const s = scoreEncoding("wir haben migration 014 am Sonntag ausgeführt");
  assert.equal(s.ephemeral, true);
});

test("ephemeral: real-world cron-stop phrase with hyphen ('Cron-Job stoppe')", () => {
  // The exact phrasing that sits in the user's DB right now.
  const s = scoreEncoding("Alex möchte, dass ich seinen Cron-Job stoppe.");
  assert.equal(s.ephemeral, true);
});

test("ephemeral override beats importance keywords", () => {
  // "wichtig" would normally boost importance; the ephemeral override wins.
  const s = scoreEncoding("wichtig: lösche das backup file vor dem deploy");
  assert.equal(s.ephemeral, true);
  assert.equal(s.importance, 0.1);
});

test("not ephemeral: plain factual sentence", () => {
  const s = scoreEncoding("der himmel ist blau");
  assert.equal(s.ephemeral, false);
  assert.equal(s.decay_tau_days, 30);
});

test("not ephemeral: user profile fact", () => {
  const s = scoreEncoding("Reed ist Data Scientist und arbeitet an vectormemory");
  assert.equal(s.ephemeral, false);
});

test("not ephemeral: policy / rule ('immer', 'niemals')", () => {
  const s = scoreEncoding("niemals `git push --force` auf main ausführen");
  assert.equal(s.ephemeral, false);
});

test("not ephemeral: stated preference ('bevorzugt')", () => {
  const s = scoreEncoding("Reed bevorzugt, dass wir vor dem push alle tests laufen lassen");
  assert.equal(s.ephemeral, false);
});

test("not ephemeral: decision / convention ('wir nutzen')", () => {
  const s = scoreEncoding("wir nutzen Supabase mit pgvector als Vektordatenbank");
  assert.equal(s.ephemeral, false);
});

test("not ephemeral: standing rule with 'ab jetzt'", () => {
  // User escalated a one-off into a rule → must NOT be ephemeral.
  const s = scoreEncoding("ab jetzt stoppen wir alle cron jobs vor dem deploy");
  assert.equal(s.ephemeral, false);
});
