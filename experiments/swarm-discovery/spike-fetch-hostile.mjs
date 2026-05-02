#!/usr/bin/env node
// Wave 3 negative-path spike — empirically test the discovery-fetch layer
// against hostile or buggy publishers.
//
// Context: spike-mdns-fetch.mjs validated the *happy* path (37 ms total
// for mDNS-up → fetch /.well-known/mycelium-node → JSON parse → shape
// check). That spike intentionally noted in its own header that signature
// verification is out of scope. What it did NOT cover, but a real Wave-3
// implementation MUST cover, is: how does the discoverer behave when the
// publisher misbehaves?
//
// mDNS itself is a passive pointer — the security boundary lives at the
// HTTPS+JSON+shape layer. SWARM_SPEC §10.2 single-strike + Pillar 6 say
// the receiver pipeline must reject malformed inputs without crashing,
// hanging, or consuming unbounded resources. This spike enumerates the
// failure modes a discoverer can encounter in the wild and records how
// each one is handled today.
//
// Scenarios run in one process against a single HTTP server with multiple
// endpoint paths (mDNS is skipped — it would just be re-validating layer
// L1 again). For each scenario we time the fetch, record the verdict, and
// flag whether the current implementation already protects against it.
//
//   GET /404            -> 404 Not Found
//   GET /malformed      -> 200 with broken JSON ("{not valid json")
//   GET /wrongshape     -> 200 with valid JSON missing required fields
//   GET /slow           -> 200 but the body is held back longer than the
//                          fetch timeout (3 s > 2 s budget)
//   GET /huge           -> 200 with a body that streams forever (we cut
//                          ourselves off at SPIKE_HUGE_BUDGET_BYTES so
//                          the spike doesn't actually OOM the host) —
//                          documents the absence of a body cap on the
//                          fetch path as a hardening gap.
//
// Output: JSON report on stdout, single-line verdict on stderr (matches
// the other Wave-3 spikes' convention).

import { performance } from "node:perf_hooks";
import { createServer, request as httpRequest } from "node:http";

const FETCH_TIMEOUT_MS = 2_000;
const HUGE_SCENARIO_HARD_CAP_BYTES = 5 * 1024 * 1024; // 5 MiB self-protection
const SLOW_DELAY_MS = 3_000; // longer than FETCH_TIMEOUT_MS on purpose

const report = {
  spike: "wave-3-fetch-hostile",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  budget: { fetch_ms: FETCH_TIMEOUT_MS, huge_self_cap_bytes: HUGE_SCENARIO_HARD_CAP_BYTES },
  scenarios: {},
};

let server;
let port = 0;

// Start a single HTTP server that exposes one endpoint per scenario. This
// is cheaper than five separate ports and keeps the test surface honest:
// each request takes the same TCP path — the difference is only what the
// server chooses to send back.
async function startHostileServer() {
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      switch (req.url) {
        case "/404":
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("not found\n");
          return;

        case "/malformed":
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{not valid json");
          return;

        case "/wrongshape": {
          // Valid JSON but missing every required NodeAdvertisement field.
          const body = JSON.stringify({ hello: "world", spec_version: "1.1" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
          return;
        }

        case "/slow":
          // Send headers immediately, withhold body past the discoverer's
          // FETCH_TIMEOUT_MS. This exercises the timeout path, not the
          // connect-error path — they are different bugs.
          res.writeHead(200, { "Content-Type": "application/json" });
          setTimeout(() => res.end('{"node_id":"slow"}'), SLOW_DELAY_MS);
          return;

        case "/huge": {
          // Send a body large enough that the discoverer's self-cap fires
          // (the spike caps at 5 MiB). We pick 12 MiB total — bounded so
          // the spike never hangs even if the cap is broken, but big
          // enough that the cap path is unmistakably exercised. The point
          // is to *document* that the production fetch path has no such
          // cap today; here we just need empirical evidence of how the
          // current shape behaves when fed too many bytes.
          res.writeHead(200, { "Content-Type": "application/json" });
          const chunk = Buffer.alloc(64 * 1024, "x"); // 64 KiB
          const totalChunks = 192; // 192 * 64 KiB = 12 MiB
          let i = 0;
          let aborted = false;
          res.on("close", () => {
            aborted = true;
          });
          const writeNext = () => {
            if (aborted) return;
            if (i >= totalChunks) {
              res.end();
              return;
            }
            i += 1;
            const ok = res.write(chunk);
            if (!ok) res.once("drain", writeNext);
            else setImmediate(writeNext);
          };
          writeNext();
          return;
        }

        default:
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end();
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
}

// Mirrors spike-mdns-fetch.mjs's fetchUrl() — keep them in lockstep so
// findings here apply to the same code shape that ships in the implementation.
function fetchUrl(url, { selfCapBytes } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chunks = [];
    let total = 0;
    let capped = false;
    let timedOut = false;
    let errored = null;

    const req = httpRequest(url, { method: "GET" }, (res) => {
      res.on("data", (c) => {
        if (capped) return;
        total += c.length;
        if (selfCapBytes && total > selfCapBytes) {
          capped = true;
          req.destroy(new Error(`self-cap reached at ${total} bytes`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const ms = Math.round(performance.now() - t0);
        resolve({
          ok: res.statusCode === 200 && !capped && !timedOut && !errored,
          status: res.statusCode ?? 0,
          ms,
          bytes: total,
          capped,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => {
        errored = String(err);
      });
    });
    req.on("error", (err) => {
      const ms = Math.round(performance.now() - t0);
      resolve({
        ok: false,
        status: 0,
        ms,
        bytes: total,
        capped,
        timed_out: timedOut,
        error: String(err),
      });
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      timedOut = true;
      req.destroy(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS} ms`));
    });
    req.end();
  });
}

function shapeCheckAdvertisement(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not an object" };
  }
  const required = ["node_id", "pubkey", "endpoint_url", "signed_at"];
  const missing = required.filter((k) => typeof parsed[k] !== "string");
  if (missing.length > 0) return { ok: false, reason: `missing: ${missing.join(",")}` };
  if (typeof parsed.signature !== "string") return { ok: false, reason: "missing signature field" };
  return { ok: true };
}

async function runScenario(name, urlPath, expectations) {
  const url = `http://127.0.0.1:${port}${urlPath}`;
  const fetched = await fetchUrl(url, {
    selfCapBytes: name === "huge_body" ? HUGE_SCENARIO_HARD_CAP_BYTES : undefined,
  });
  let shape;
  if (fetched.ok && typeof fetched.body === "string" && fetched.body.length > 0) {
    try {
      shape = shapeCheckAdvertisement(JSON.parse(fetched.body));
    } catch (err) {
      shape = { ok: false, reason: `JSON parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else if (typeof fetched.body === "string" && fetched.body.length > 0) {
    // Body present even though fetch reported !ok (e.g. 404 with text body).
    // Still try the shape check — the production code would, and we want to
    // document what happens.
    try {
      shape = shapeCheckAdvertisement(JSON.parse(fetched.body));
    } catch (err) {
      shape = { ok: false, reason: `JSON parse: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const handled = expectations.handled(fetched, shape);
  // Strip the raw body before persisting — for the huge_body scenario it
  // is multi-MiB of filler and would bloat the report past every reader's
  // size budget. Keep a 120-byte preview instead so the report stays
  // diffable.
  const bodyPreview = typeof fetched.body === "string" && fetched.body.length > 0
    ? fetched.body.slice(0, 120) + (fetched.body.length > 120 ? "…" : "")
    : undefined;
  const fetchSummary = { ...fetched };
  delete fetchSummary.body;
  if (bodyPreview !== undefined) fetchSummary.body_preview = bodyPreview;
  report.scenarios[name] = {
    expected: expectations.summary,
    fetch: fetchSummary,
    shape,
    handled_gracefully: handled.ok,
    note: handled.note,
  };
}

async function main() {
  await startHostileServer();
  report.endpoint_root = `http://127.0.0.1:${port}`;

  await runScenario("not_found_404", "/404", {
    summary: "publisher returns 404 on /.well-known/mycelium-node",
    handled: (f) => ({
      ok: f.status === 404 && !f.ok,
      note: "fetch reports status=404 + ok=false; shape skipped because body is not JSON",
    }),
  });

  await runScenario("malformed_json", "/malformed", {
    summary: "publisher returns 200 with broken JSON body",
    handled: (f, s) => ({
      ok: f.ok && s && !s.ok && /JSON parse/.test(s.reason),
      note: "shape-check rejects with 'JSON parse: …' reason",
    }),
  });

  await runScenario("wrong_shape", "/wrongshape", {
    summary: "publisher returns 200 with JSON missing required fields",
    handled: (f, s) => ({
      ok: f.ok && s && !s.ok && /missing/.test(s.reason),
      note: "shape-check rejects with 'missing: …' reason",
    }),
  });

  await runScenario("slow_response", "/slow", {
    summary: `publisher delays body by ${SLOW_DELAY_MS} ms (> ${FETCH_TIMEOUT_MS} ms budget)`,
    handled: (f) => ({
      ok: !f.ok && (f.timed_out || /timeout/.test(f.error ?? "")) && f.ms <= FETCH_TIMEOUT_MS + 250,
      note: `fetch aborts within ~${FETCH_TIMEOUT_MS} ms — no hang past budget`,
    }),
  });

  await runScenario("huge_body", "/huge", {
    summary: "publisher streams unbounded body (no Content-Length cap on receiver)",
    handled: (f) => ({
      // Today the production code has NO body cap. The spike's self-cap
      // is what stops it; the spike treats *that* as the "graceful" path
      // because the spike is the experiment — but the *finding* is that
      // the receiver pipeline lacks the cap and must add one.
      ok: f.capped === true && f.bytes >= HUGE_SCENARIO_HARD_CAP_BYTES && f.ms <= FETCH_TIMEOUT_MS + 250,
      note: "self-cap halted the read — production receiver MUST enforce a body cap (HARDENING GAP)",
    }),
  });

  server.close();

  // Summary — total scenarios handled gracefully + named gaps.
  const entries = Object.entries(report.scenarios);
  const handled = entries.filter(([, s]) => s.handled_gracefully).length;
  const gaps = entries
    .filter(([, s]) => /HARDENING GAP/.test(s.note ?? ""))
    .map(([k]) => k);
  report.summary = {
    scenarios: entries.length,
    handled_gracefully: handled,
    hardening_gaps: gaps,
  };
  report.finished_at = new Date().toISOString();

  const verdict = entries.map(([k, s]) => `${k}:${s.handled_gracefully ? "ok" : "FAIL"}`).join(" ");
  const gapsLine = gaps.length > 0 ? `  · gaps: ${gaps.join(",")}` : "";
  console.error(`[spike-fetch-hostile] ${handled}/${entries.length} handled gracefully  · ${verdict}${gapsLine}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("[spike-fetch-hostile] uncaught:", err);
  process.exit(1);
});
