/**
 * Contract tests for the GET /swarm/lessons handler — issue #139, slice 1.
 *
 * Pure handler-level tests. The loader is injected, so no DB / HTTP is
 * required; the integration test that exercises the full URL → SQL path
 * ships with the wiring PR.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLessonFeedResponse,
  computeNextSince,
  resolveLimit,
  resolveSince,
  DEFAULT_SINCE_LOOKBACK_MS,
  LIMIT_DEFAULT,
  LIMIT_MAX,
  LIMIT_MIN,
  type LessonFeedDeps,
  type LessonFeedResponseBody,
} from "../swarm/endpoints/lesson-feed.js";
import { WIRE_SPEC_VERSION, type Lesson } from "../services/wire-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date("2026-05-01T12:00:00.000Z");

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    content: "If A then B because C.",
    embedding: new Array(768).fill(0),
    synthesized_from_cluster_size: 3,
    origin_node_id:
      "QmTfCejgo2wTwqnDJs8Lu1pCNeCrCDuE4GAwkna93zdd7d",
    signed_at: "2026-04-30T10:00:00.000Z",
    signature: "sig-base64-placeholder==",
    created_at: "2026-04-30T09:00:00.000Z",
    spec_version: WIRE_SPEC_VERSION,
    ...overrides,
  };
}

function freshDeps(over: Partial<LessonFeedDeps>): LessonFeedDeps {
  return {
    now: () => FROZEN_NOW,
    loadEligibleLessons: async () => [],
    ...over,
  };
}

async function readBody(res: { body: string }): Promise<unknown> {
  return JSON.parse(res.body);
}

// ---------------------------------------------------------------------------
// resolveSince — pure helper
// ---------------------------------------------------------------------------

test("resolveSince defaults to now − 24h when no value supplied", () => {
  for (const raw of [null, undefined, ""] as const) {
    const r = resolveSince(raw, FROZEN_NOW);
    assert.equal(r.ok, true, `expected ok for ${JSON.stringify(raw)}`);
    if (!r.ok) return;
    assert.equal(
      r.since.getTime(),
      FROZEN_NOW.getTime() - DEFAULT_SINCE_LOOKBACK_MS
    );
  }
});

test("resolveSince accepts strict ISO8601 with Z", () => {
  const r = resolveSince("2026-04-30T10:20:30Z", FROZEN_NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.since.toISOString(), "2026-04-30T10:20:30.000Z");
});

test("resolveSince accepts strict ISO8601 with milliseconds + Z", () => {
  const r = resolveSince("2026-04-30T10:20:30.123Z", FROZEN_NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.since.toISOString(), "2026-04-30T10:20:30.123Z");
});

test("resolveSince accepts strict ISO8601 with offset timezone", () => {
  const r = resolveSince("2026-04-30T12:20:30+02:00", FROZEN_NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // Same instant as 10:20:30Z.
  assert.equal(r.since.toISOString(), "2026-04-30T10:20:30.000Z");
});

test("resolveSince rejects ISO8601 without timezone designator", () => {
  const r = resolveSince("2026-04-30T10:20:30", FROZEN_NOW);
  assert.equal(r.ok, false);
});

test("resolveSince rejects date-only strings", () => {
  const r = resolveSince("2026-04-30", FROZEN_NOW);
  assert.equal(r.ok, false);
});

test("resolveSince rejects garbage strings", () => {
  for (const raw of ["yesterday", "tomorrow", "1714478400", "not-a-date"]) {
    const r = resolveSince(raw, FROZEN_NOW);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(raw)}`);
  }
});

// ---------------------------------------------------------------------------
// resolveLimit — pure helper
// ---------------------------------------------------------------------------

test("resolveLimit defaults when no value supplied", () => {
  for (const raw of [null, undefined, ""] as const) {
    const r = resolveLimit(raw);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.limit, LIMIT_DEFAULT);
  }
});

test("resolveLimit accepts string-of-digits in range", () => {
  const r = resolveLimit("75");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.limit, 75);
});

test("resolveLimit accepts numeric integer in range", () => {
  const r = resolveLimit(42);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.limit, 42);
});

test("resolveLimit clamps values above LIMIT_MAX", () => {
  const r = resolveLimit("9999");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.limit, LIMIT_MAX);
});

test("resolveLimit clamps values below LIMIT_MIN (zero / negative)", () => {
  for (const raw of ["0", "-5", 0, -1] as const) {
    const r = resolveLimit(raw);
    assert.equal(r.ok, true, `expected ok for ${raw}`);
    if (!r.ok) return;
    assert.equal(r.limit, LIMIT_MIN, `for ${raw}`);
  }
});

test("resolveLimit rejects decimals, scientific, hex, and trailing garbage", () => {
  for (const raw of ["1.5", "1e2", "0x10", "10abc", "abc"] as const) {
    const r = resolveLimit(raw);
    assert.equal(r.ok, false, `expected reject for ${JSON.stringify(raw)}`);
  }
});

test("resolveLimit rejects non-integer numbers", () => {
  const r = resolveLimit(1.5);
  assert.equal(r.ok, false);
});

test("resolveLimit rejects NaN and Infinity", () => {
  for (const raw of [Number.NaN, Number.POSITIVE_INFINITY] as const) {
    const r = resolveLimit(raw);
    assert.equal(r.ok, false, `expected reject for ${raw}`);
  }
});

// ---------------------------------------------------------------------------
// computeNextSince — pure helper
// ---------------------------------------------------------------------------

test("computeNextSince returns null for empty page", () => {
  assert.equal(computeNextSince([]), null);
});

test("computeNextSince returns null when input is non-array", () => {
  // @ts-expect-error — defensive against malformed loaders.
  assert.equal(computeNextSince(null), null);
});

test("computeNextSince returns max(signed_at)+1ms for one row", () => {
  const r = computeNextSince([lesson({ signed_at: "2026-04-30T10:00:00.000Z" })]);
  assert.equal(r, "2026-04-30T10:00:00.001Z");
});

test("computeNextSince returns max(signed_at)+1ms across rows", () => {
  const r = computeNextSince([
    lesson({ id: "a", signed_at: "2026-04-29T10:00:00.000Z" }),
    lesson({ id: "b", signed_at: "2026-04-30T11:30:00.500Z" }),
    lesson({ id: "c", signed_at: "2026-04-30T08:00:00.000Z" }),
  ]);
  assert.equal(r, "2026-04-30T11:30:00.501Z");
});

// ---------------------------------------------------------------------------
// buildLessonFeedResponse — happy path
// ---------------------------------------------------------------------------

test("returns 200 + empty page when no rows match", async () => {
  const res = await buildLessonFeedResponse(freshDeps({}));
  assert.equal(res.status, 200);
  assert.equal(res.headers["Content-Type"], "application/json; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-store");
  const body = (await readBody(res)) as LessonFeedResponseBody;
  assert.deepEqual(body.lessons, []);
  assert.equal(body.next_since, null);
});

test("returns 200 + page envelope with rows + cursor", async () => {
  const a = lesson({
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    signed_at: "2026-04-30T10:00:00.000Z",
  });
  const b = lesson({
    id: "bbbbbbbb-2222-4222-8222-222222222222",
    signed_at: "2026-04-30T11:00:00.250Z",
  });
  const res = await buildLessonFeedResponse(
    freshDeps({ loadEligibleLessons: async () => [a, b] })
  );
  assert.equal(res.status, 200);
  const body = (await readBody(res)) as LessonFeedResponseBody;
  assert.equal(body.lessons.length, 2);
  assert.equal(body.lessons[0].id, a.id);
  assert.equal(body.lessons[1].id, b.id);
  assert.equal(body.next_since, "2026-04-30T11:00:00.251Z");
});

test("relays loader rows verbatim — handler does not re-shape envelopes", async () => {
  // Receiver re-validates the producer signature over JCS(record − signature),
  // so any field rename / drop / re-order would break verification. Handler
  // MUST pass rows through untouched.
  const v11 = lesson({
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    spec_version: "1.1",
    evidence_root: "QmTestRootRootRootRootRootRootRootRootRootRoo",
    evidence_count: 5,
    prev_lesson_hash: "QmTestPrevPrevPrevPrevPrevPrevPrevPrevPrevPre",
    maturity_age_days: 7,
    useful_count: 2,
    tags: ["test", "v1.1"],
  });
  const res = await buildLessonFeedResponse(
    freshDeps({ loadEligibleLessons: async () => [v11] })
  );
  assert.equal(res.status, 200);
  const body = (await readBody(res)) as LessonFeedResponseBody;
  const got = body.lessons[0];
  assert.equal(got.spec_version, "1.1");
  assert.equal(got.evidence_root, v11.evidence_root);
  assert.equal(got.evidence_count, 5);
  assert.equal(got.prev_lesson_hash, v11.prev_lesson_hash);
  assert.equal(got.maturity_age_days, 7);
  assert.equal(got.useful_count, 2);
  assert.deepEqual(got.tags, ["test", "v1.1"]);
  assert.equal(got.signature, v11.signature);
});

// ---------------------------------------------------------------------------
// buildLessonFeedResponse — defaulting behaviour passed to loader
// ---------------------------------------------------------------------------

test("defaults since to now − 24h when omitted", async () => {
  let captured: { since: Date; limit: number } | null = null;
  await buildLessonFeedResponse(
    freshDeps({
      loadEligibleLessons: async (args) => {
        captured = args;
        return [];
      },
    })
  );
  assert.ok(captured, "loader must be called");
  const args = captured as unknown as { since: Date; limit: number };
  assert.equal(
    args.since.getTime(),
    FROZEN_NOW.getTime() - DEFAULT_SINCE_LOOKBACK_MS
  );
  assert.equal(args.limit, LIMIT_DEFAULT);
});

test("forwards a valid since to the loader", async () => {
  let captured: { since: Date; limit: number } | null = null;
  await buildLessonFeedResponse(
    freshDeps({
      since: "2026-04-29T08:00:00.000Z",
      loadEligibleLessons: async (args) => {
        captured = args;
        return [];
      },
    })
  );
  assert.ok(captured, "loader must be called");
  const args = captured as unknown as { since: Date; limit: number };
  assert.equal(args.since.toISOString(), "2026-04-29T08:00:00.000Z");
});

test("forwards a clamped limit to the loader", async () => {
  let captured: { since: Date; limit: number } | null = null;
  await buildLessonFeedResponse(
    freshDeps({
      limit: "9999",
      loadEligibleLessons: async (args) => {
        captured = args;
        return [];
      },
    })
  );
  assert.ok(captured, "loader must be called");
  const args = captured as unknown as { since: Date; limit: number };
  assert.equal(args.limit, LIMIT_MAX);
});

// ---------------------------------------------------------------------------
// buildLessonFeedResponse — input validation (400 mappings)
// ---------------------------------------------------------------------------

test("returns 400 on malformed since", async () => {
  let loaderCalled = false;
  const res = await buildLessonFeedResponse(
    freshDeps({
      since: "yesterday",
      loadEligibleLessons: async () => {
        loaderCalled = true;
        return [];
      },
    })
  );
  assert.equal(res.status, 400);
  assert.equal(loaderCalled, false, "loader MUST NOT be called on bad input");
  const body = (await readBody(res)) as { error: string; since: string };
  assert.match(body.error, /since/);
  assert.equal(body.since, "yesterday");
});

test("returns 400 on malformed limit (string)", async () => {
  let loaderCalled = false;
  const res = await buildLessonFeedResponse(
    freshDeps({
      limit: "abc",
      loadEligibleLessons: async () => {
        loaderCalled = true;
        return [];
      },
    })
  );
  assert.equal(res.status, 400);
  assert.equal(loaderCalled, false);
  const body = (await readBody(res)) as { error: string; limit: string };
  assert.match(body.error, /limit/);
  assert.equal(body.limit, "abc");
});

test("returns 400 on malformed limit (decimal)", async () => {
  const res = await buildLessonFeedResponse(
    freshDeps({ limit: "1.5" })
  );
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// buildLessonFeedResponse — loader failure (503)
// ---------------------------------------------------------------------------

test("returns 503 with operator-readable detail when loader throws", async () => {
  const res = await buildLessonFeedResponse(
    freshDeps({
      loadEligibleLessons: async () => {
        throw new Error("connection refused: postgres at localhost:54322");
      },
    })
  );
  assert.equal(res.status, 503);
  const body = (await readBody(res)) as { error: string; detail: string };
  assert.equal(body.error, "loadEligibleLessons failed");
  assert.match(body.detail, /connection refused/);
});

test("returns 503 with stringified non-Error rejections", async () => {
  const res = await buildLessonFeedResponse(
    freshDeps({
      loadEligibleLessons: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "loader exploded with a plain string";
      },
    })
  );
  assert.equal(res.status, 503);
  const body = (await readBody(res)) as { detail: string };
  assert.match(body.detail, /loader exploded/);
});

// ---------------------------------------------------------------------------
// buildLessonFeedResponse — response-shape pin (regression guard)
// ---------------------------------------------------------------------------

test("response body has only `lessons` and `next_since` at the top level", async () => {
  const res = await buildLessonFeedResponse(
    freshDeps({ loadEligibleLessons: async () => [lesson()] })
  );
  assert.equal(res.status, 200);
  const body = (await readBody(res)) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(body).sort(),
    ["lessons", "next_since"].sort(),
    "extra fields would force receivers to update — pin the contract"
  );
});

test("Cache-Control disables caching on every response (200, 400, 503)", async () => {
  const ok = await buildLessonFeedResponse(freshDeps({}));
  const bad = await buildLessonFeedResponse(
    freshDeps({ since: "yesterday" })
  );
  const fail = await buildLessonFeedResponse(
    freshDeps({
      loadEligibleLessons: async () => {
        throw new Error("x");
      },
    })
  );
  for (const r of [ok, bad, fail]) {
    assert.equal(r.headers["Cache-Control"], "no-store");
  }
});
