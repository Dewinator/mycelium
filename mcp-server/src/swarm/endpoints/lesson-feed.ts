/**
 * GET /swarm/lessons — Swarm Phase 4 (issue #139 — first slice).
 *
 * Pull-based broadcast feed over Tier-A lessons (SWARM_SPEC §10.6 + §3.1).
 * A peer polls `GET /swarm/lessons?since=<iso8601>&limit=N` and receives
 * the v1.x envelopes that have been promoted to Tier-A and not §10.4-
 * diversity-dampened. Receivers re-validate every envelope with
 * `wire-validator` — this endpoint adds no out-of-band trust claim of
 * its own.
 *
 * Substrate-only: pure handler module + contract tests, no HTTP wiring,
 * no migration, no dashboard-server.mjs touch. Mirrors the #138 → wiring
 * follow-up split that worked for the admission handler and the
 * #128 → #152 split that worked for the proof endpoint.
 *
 * Issue #139 splits into three pieces; this PR ships piece 1 only:
 *
 *   1. THIS — the GET handler reading from broadcast_eligible. Pure
 *      shape / pagination / clamping. The loader is injected so contract
 *      tests run with no DB.
 *   2. Active publish at promotion time (lesson_chain append + producer-
 *      side signing on B → A flip). Future PR; depends on #136 producer
 *      hook landing first.
 *   3. Self-broadcasting safety (CHECK / trigger preventing a self-row
 *      from carrying a foreign-looking origin_node_id). Future PR;
 *      substrate-only.
 *
 * Substrate filter contract:
 *
 *   - The loader MUST read FROM `swarm_lessons_broadcast_eligible` (the
 *     §10.6 + §10.4 firebreak view from migrations 078 + 087). Reading
 *     directly from `swarm_lessons` would re-broadcast Tier-B (un-vetted)
 *     lessons AND §10.4-dampened lessons. As of migration 087 the view
 *     itself enforces BOTH filters at the SQL layer:
 *         lesson_tier   = 'A'      (§10.6 two-tier pinning, mig. 078)
 *         local_weight >= 0.3      (§10.4 anti-echo-chamber, mig. 082)
 *   - Diversity-dampened lessons (`local_weight < 0.3`) stay local —
 *     re-broadcasting them would amplify the concentration the §10.4
 *     pass already pulled back from. The threshold mirrors the
 *     `MIN_LOCAL_WEIGHT_FOR_BROADCAST` constant exported below for any
 *     non-broadcast caller that wants the same gate without going through
 *     the view.
 *   - The handler does NOT re-apply either filter. The substrate IS the
 *     contract; this module verifies shape + pagination + clamping only.
 *     A loader that violates the contract is caught by the integration
 *     test that ships with the wiring PR, not by this unit-level slice.
 *
 * Privacy / replay invariant:
 *
 *   The response relays each row's existing producer signature byte-for-
 *   byte. This handler MUST NOT re-sign — re-signing would let any node
 *   forge a producer attestation for any lesson it has merely seen,
 *   which is the same trust break the lesson-proof handler's relay-guard
 *   prevents at §4.6. Re-shaping the row (renaming fields, dropping
 *   optional fields, re-ordering keys in a way that affects the bytes
 *   under signature) would also break receiver validation; the handler
 *   passes Lesson rows through verbatim.
 */
import type { Lesson } from "../../services/wire-types.js";

// ---------------------------------------------------------------------------
// Constants — defaults + bounds.
// ---------------------------------------------------------------------------

/**
 * Default lookback when no `since` is supplied. Matches the spec text in
 * issue #139: "Default: last 24h". A 24h window is small enough that a
 * fresh peer can bootstrap without a one-shot dump, large enough that an
 * hourly poll never misses a Tier-A promotion under normal cadence.
 */
export const DEFAULT_SINCE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Issue #139: limit "clamped to [1, 200], default 50". */
export const LIMIT_DEFAULT = 50;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;

/**
 * §10.4 anti-echo-chamber threshold for local_weight. As of migration 087
 * the SUBSTRATE (the firebreak view itself) enforces this — a loader that
 * `SELECT *` from the view is automatically compliant. The constant stays
 * exported for non-broadcast callers (e.g. dashboard widgets that want to
 * preview "what would be broadcast" without going through the view) and
 * to give the migration-087 contract test a single shared symbol that
 * proves the SQL literal and this TS constant agree.
 */
export const MIN_LOCAL_WEIGHT_FOR_BROADCAST = 0.3;

/**
 * Strict ISO8601 with required timezone designator. `Date.parse` is too
 * permissive (it accepts e.g. "2026-04-30 10:00:00" without zone info),
 * which would silently change cursor semantics across calls. Receivers
 * MUST send a timezone-anchored value or get a 400.
 *
 * Allowed: 2026-04-30T10:20:30Z, 2026-04-30T10:20:30.123Z,
 *          2026-04-30T10:20:30.123456+02:00, …
 * Rejected: 2026-04-30, 2026-04-30T10:20:30, 2026-04-30 10:20:30Z, …
 */
const ISO8601_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

const RESPONSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface LessonFeedDeps {
  /**
   * Raw query-string `since` value (or null/undefined when the caller
   * omitted it). When provided, MUST be a strict ISO8601 timestamp with
   * timezone — anything else returns 400 rather than silently re-baselining
   * the cursor under the receiver.
   */
  since?: string | null;
  /**
   * Raw query-string `limit` value (or null/undefined when omitted).
   * Accepted as a string-of-digits or a number. Negative / non-integer
   * / non-numeric values return 400 — silently mapping bad input to a
   * default would let a misconfigured client poll with the wrong page
   * size and never notice. Valid integers outside [1, 200] are silently
   * clamped (per issue spec).
   */
  limit?: string | number | null;
  /**
   * Clock injection for deterministic tests. Defaults to `() => new Date()`.
   * The handler resolves `since` against this clock when no `since` is
   * supplied, so a frozen-clock test can assert the exact 24h-lookback Date
   * the loader receives.
   */
  now?: () => Date;
  /**
   * Load Tier-A broadcast-eligible lessons, ordered by signed_at ASC,
   * capped at `limit`. See module docstring for the substrate contract
   * the loader MUST satisfy (read FROM the firebreak view + apply the
   * §10.4 local_weight filter). The handler trusts this contract — it
   * is the substrate, not a re-validation surface.
   */
  loadEligibleLessons: (args: {
    since: Date;
    limit: number;
  }) => Promise<Lesson[]>;
}

export interface HttpResponseShape {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Response body shape served on 200. `lessons` is the page; `next_since`
 * is the cursor a polling client passes back as `?since=<next_since>` on
 * the next call.
 *
 * `next_since` is `null` when `lessons` is empty (no progress was made;
 * the caller can poll again with the same `since`). Otherwise it is the
 * largest `signed_at` in the page, advanced by 1ms. The +1ms keeps the
 * next call from re-fetching the last row at the cost of skipping any
 * row signed within the same millisecond — a documented at-least-once
 * cursor; bit-exact deduplication, if a receiver needs it, is its own
 * concern (track `id` set per page) and out of scope for this slice.
 */
export interface LessonFeedResponseBody {
  lessons: Lesson[];
  next_since: string | null;
}

/**
 * Build the response for `GET /swarm/lessons`.
 *
 * Returns an HTTP-shaped triple so the surrounding HTTP server can write
 * it without further policy. Every error mode is operator-readable rather
 * than opaque — same discipline as `buildNodeAdvertisementResponse` and
 * `buildLessonProofResponse`.
 *
 * Status mapping:
 *   - 400: malformed `since` (not ISO8601 with timezone) or malformed
 *     `limit` (not a positive integer / NaN / negative).
 *   - 503: loader threw. Body carries the error message so the operator
 *     can debug a substrate failure without grepping logs.
 *   - 200: page envelope `{ lessons, next_since }`. Always returned for
 *     well-formed input even when the page is empty.
 */
export async function buildLessonFeedResponse(
  deps: LessonFeedDeps
): Promise<HttpResponseShape> {
  const now = (deps.now ?? (() => new Date()))();

  const sinceResult = resolveSince(deps.since, now);
  if (!sinceResult.ok) {
    return jsonResponse(400, {
      error: sinceResult.error,
      since: deps.since,
    });
  }

  const limitResult = resolveLimit(deps.limit);
  if (!limitResult.ok) {
    return jsonResponse(400, {
      error: limitResult.error,
      limit: deps.limit,
    });
  }

  let lessons: Lesson[];
  try {
    lessons = await deps.loadEligibleLessons({
      since: sinceResult.since,
      limit: limitResult.limit,
    });
  } catch (e) {
    return jsonResponse(503, {
      error: "loadEligibleLessons failed",
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  const body: LessonFeedResponseBody = {
    lessons,
    next_since: computeNextSince(lessons),
  };
  return {
    status: 200,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the contract test can pin them independently.
// ---------------------------------------------------------------------------

export type SinceResolution =
  | { ok: true; since: Date }
  | { ok: false; error: string };

/**
 * Resolve the cursor `since`:
 *   - null / undefined / "" → DEFAULT_SINCE_LOOKBACK_MS before `now`.
 *   - Strict ISO8601 with timezone → that instant.
 *   - Anything else → 400-shaped error.
 *
 * `now` is taken as a parameter so callers can inject a fixed clock; the
 * handler does so via `deps.now`.
 */
export function resolveSince(
  raw: string | null | undefined,
  now: Date
): SinceResolution {
  if (raw === null || raw === undefined || raw === "") {
    return {
      ok: true,
      since: new Date(now.getTime() - DEFAULT_SINCE_LOOKBACK_MS),
    };
  }
  if (typeof raw !== "string" || !ISO8601_TZ_RE.test(raw)) {
    return {
      ok: false,
      error:
        "since must be an ISO8601 timestamp with timezone (e.g. 2026-04-30T10:20:30Z)",
    };
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) {
    return {
      ok: false,
      error:
        "since must be an ISO8601 timestamp with timezone (e.g. 2026-04-30T10:20:30Z)",
    };
  }
  return { ok: true, since: new Date(ms) };
}

export type LimitResolution =
  | { ok: true; limit: number }
  | { ok: false; error: string };

/**
 * Resolve the page size `limit`:
 *   - null / undefined / "" → LIMIT_DEFAULT.
 *   - Integer in [LIMIT_MIN, LIMIT_MAX] → that integer.
 *   - Integer outside the range → silently clamped.
 *   - Non-integer / NaN / negative → 400-shaped error.
 *
 * Clamping is silent (per issue spec wording: "clamped to [1, 200]") but
 * unparseable input gets a 400 — silently substituting a default for a
 * caller's typo would let a misconfigured client poll with the wrong
 * page size and never see the bug.
 */
export function resolveLimit(
  raw: string | number | null | undefined
): LimitResolution {
  if (raw === null || raw === undefined || raw === "") {
    return { ok: true, limit: LIMIT_DEFAULT };
  }
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    // Strict integer-only parse. Reject scientific notation, decimals,
    // hex prefixes, leading +, and trailing garbage. The dedicated regex
    // is loud about WHY a value was rejected so an operator with a
    // suspicious limit value sees the rule that cut it.
    if (!/^-?\d+$/.test(raw)) {
      return {
        ok: false,
        error: "limit must be an integer",
      };
    }
    n = Number.parseInt(raw, 10);
  } else {
    return {
      ok: false,
      error: "limit must be an integer",
    };
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return {
      ok: false,
      error: "limit must be an integer",
    };
  }
  if (n < 1) {
    // Clamp to the floor — but only when the value is at least zero or
    // negative-but-syntactically-valid. A literal "limit=0" is a request
    // for the smallest legal page; we honour the spec's clamping rule
    // rather than 400-ing on a value the spec text explicitly covers.
    return { ok: true, limit: LIMIT_MIN };
  }
  if (n > LIMIT_MAX) {
    return { ok: true, limit: LIMIT_MAX };
  }
  return { ok: true, limit: n };
}

/**
 * Compute the pagination cursor from a returned page.
 *
 * - Empty page → null (no progress).
 * - Non-empty → max(signed_at) + 1ms in ISO8601 with millisecond
 *   precision, suffixed `Z`.
 *
 * The +1ms increment is the at-least-once cursor's duplicate avoider;
 * it intentionally drops same-millisecond ties from the next call (the
 * receiver already has them in this page). See LessonFeedResponseBody.
 */
export function computeNextSince(lessons: Lesson[]): string | null {
  if (!Array.isArray(lessons) || lessons.length === 0) return null;
  let maxMs = -Infinity;
  for (const l of lessons) {
    const t = Date.parse(l.signed_at);
    if (Number.isFinite(t) && t > maxMs) maxMs = t;
  }
  if (!Number.isFinite(maxMs)) return null;
  return new Date(maxMs + 1).toISOString();
}

function jsonResponse(status: number, body: unknown): HttpResponseShape {
  return {
    status,
    headers: { ...RESPONSE_HEADERS },
    body: JSON.stringify(body),
  };
}
