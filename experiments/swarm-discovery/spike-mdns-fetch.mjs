#!/usr/bin/env node
// Wave 3 mDNS+fetch spike — validate the full pointer→advertisement loop.
//
// `spike-mdns.mjs` validated only the mDNS layer (publish/discover). The
// design spike (docs/swarm-discovery-spike.md) is explicit that mDNS is a
// **pointer**, not a substitute for the signed record: a discoverer MUST
// follow the URL in the TXT record and fetch `/.well-known/mycelium-node`
// before treating the peer as anything more than "seen on the LAN". This
// spike closes that gap empirically — it runs the whole loop and times it
// against the spike's "≤2 s typical" budget.
//
// What this validates that spike-mdns.mjs does NOT:
//   - the publisher actually serves an HTTP /.well-known/mycelium-node
//     endpoint and the URL pointer in mDNS is real, not aspirational;
//   - the discoverer can resolve the mDNS hostname, open a TCP connection,
//     receive the body, parse JSON, and run a `kindOf`-equivalent shape
//     check on the payload;
//   - the round-trip stays inside the 2-second budget on a single host.
//
// Body cap (added 2026-05-03): `fetchUrl` enforces a 64 KiB self-cap on
// the response body. spike-fetch-hostile.mjs (commit 498564e) named the
// absence of this cap as the spike's only hardening gap — without it, a
// hostile publisher streaming MiBs of filler can wedge a discoverer until
// the timeout expires. With the cap, the read aborts the moment a peer
// exceeds the (generous) advertisement-size budget. NodeAdvertisement
// payloads are <1 KiB in practice; 64 KiB leaves plenty of headroom for
// future signed-receipt fields without leaving a DoS vector open. The
// implementation PR for issue 1 in docs/swarm-discovery-spike.md's
// "Concrete next steps" can now lift `fetchUrl` here verbatim.
//
// What this is NOT:
//   - signature verification (the mock advertisement is unsigned — that
//     belongs in the Wave-2 trust-handshake spike, not the discovery one);
//   - HTTPS (the design spike calls for https:// in production but the
//     loopback validation only needs to prove the wire path works; the
//     TLS layer is orthogonal to the discovery question);
//   - cross-host (still single-machine; cross-host validation is a
//     separate item — see "still open" in docs/swarm-discovery-spike.md).
//
// Modes:
//   --publish   serve the well-known endpoint + advertise via mDNS, hold
//               open until SIGINT (or SPIKE_PUBLISH_MS env)
//   --discover  browse mDNS, on first hit fetch the URL, parse, exit
//   default     both in one process (cheapest single-machine smoke test)
//
// Output: JSON report on stdout, one-line verdict on stderr (matches
// spike-mdns.mjs / native-pg / native-llm convention).

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";

// Loopback IP, not `os.hostname() + .local`. Why: this spike validates the
// fetch-after-discovery loop on a single host. mDNS-name resolution
// (e.g. Mac.local → 192.168.1.x) is a separate, environment-dependent
// concern that the bonjour-service `addresses` field already covers; the
// spike doesn't need to re-prove it. Cross-host validation, when it runs,
// will use the addresses array bonjour-service provides on `up`.
const LOOPBACK_HOST = "127.0.0.1";

const args = new Set(process.argv.slice(2));
const MODE_PUBLISH = args.has("--publish");
const MODE_DISCOVER = args.has("--discover");
const MODE_BOTH = !MODE_PUBLISH && !MODE_DISCOVER;

const SERVICE_TYPE = "mycelium";
const DISCOVER_TIMEOUT_MS = MODE_DISCOVER ? 30_000 : 5_000;
const FETCH_TIMEOUT_MS = 2_000;
// 64 KiB — `NodeAdvertisement` payloads are <1 KiB in practice; a publisher
// streaming more than this is hostile or buggy. spike-fetch-hostile.mjs
// (2026-05-03) named the absence of this cap as the spike's only
// hardening gap; backporting it here so the implementation can lift
// `fetchUrl` verbatim instead of having to add a cap retroactively.
const BODY_SELF_CAP_BYTES = 64 * 1024;
const PUBLISH_LIFETIME_MS = MODE_PUBLISH
  ? Number(process.env.SPIKE_PUBLISH_MS) || 0
  : 0;
const FAKE_NODE_ID = `spike-${process.pid}`;
const FAKE_PUBKEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32-byte zero, mock
const FAKE_DISPLAY_NAME = "spike-mdns-fetch";

const report = {
  spike: "wave-3-mdns-fetch",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http",
  mode: MODE_BOTH ? "both" : MODE_PUBLISH ? "publish-only" : "discover-only",
  budget: {
    discover_ms: DISCOVER_TIMEOUT_MS,
    fetch_ms: FETCH_TIMEOUT_MS,
    total_target_ms: 2000,
    body_self_cap_bytes: BODY_SELF_CAP_BYTES,
  },
  steps: {},
};

let bonjour;
let publisher;
let browser;
let httpServer;
let httpPort = 0;
let advUrl;

function buildMockAdvertisement(port) {
  // Shape mirrors mcp-server/src/services/wire-types.ts NodeAdvertisement.
  // Spike payload — `signature` is a placeholder; the discoverer's
  // shape-check intentionally does not verify it (that belongs in the
  // trust-handshake spike, not here).
  return {
    node_id: FAKE_NODE_ID,
    pubkey: FAKE_PUBKEY_B64,
    display_name: FAKE_DISPLAY_NAME,
    endpoint_url: `http://${LOOPBACK_HOST}:${port}`,
    spec_version: "1.1",
    signed_at: new Date().toISOString(),
    signature: "MOCK-NOT-A-REAL-ED25519-SIGNATURE",
  };
}

async function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer = createServer((req, res) => {
      if (req.url === "/.well-known/mycelium-node" && req.method === "GET") {
        const body = JSON.stringify(buildMockAdvertisement(httpPort));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
    });
    httpServer.once("error", reject);
    httpServer.listen(0, "0.0.0.0", () => {
      httpPort = httpServer.address().port;
      advUrl = `http://${LOOPBACK_HOST}:${httpPort}/.well-known/mycelium-node`;
      report.service = {
        type: SERVICE_TYPE,
        fqdn: `_${SERVICE_TYPE}._tcp.local`,
        http_port: httpPort,
        adv_url: advUrl,
        txt: { url: advUrl, node_id: FAKE_NODE_ID, spec: "v1" },
      };
      resolve();
    });
  });
}

async function publish() {
  const t0 = performance.now();
  try {
    publisher = bonjour.publish({
      name: `mycelium-${FAKE_NODE_ID}`,
      type: SERVICE_TYPE,
      port: httpPort,
      txt: report.service.txt,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    report.steps.publish = { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    report.steps.publish = { ok: false, error: String(err) };
  }
}

function fetchUrl(url, { selfCapBytes = BODY_SELF_CAP_BYTES } = {}) {
  // Thin wrapper around node:http with a hard timeout AND a body self-cap.
  // `fetch` would work but pulls in undici and obscures where time is spent.
  // The spike wants every millisecond accounted for, and the cap closes the
  // bytes-on-the-wire DoS vector that spike-fetch-hostile.mjs documented:
  // a hostile publisher streaming MiBs of filler can wedge a discoverer
  // until the timeout expires unless we cut the read short ourselves.
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const chunks = [];
    let total = 0;
    let capped = false;
    const req = httpRequest(url, { method: "GET" }, (res) => {
      res.on("data", (c) => {
        if (capped) return;
        total += c.length;
        if (selfCapBytes && total > selfCapBytes) {
          capped = true;
          req.destroy(new Error(`body self-cap reached at ${total} bytes (max ${selfCapBytes})`));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const ms = Math.round(performance.now() - t0);
        resolve({
          ok: res.statusCode === 200 && !capped,
          status: res.statusCode ?? 0,
          ms,
          body: Buffer.concat(chunks).toString("utf8"),
          bytes: total,
          capped,
          content_type: res.headers["content-type"] ?? "",
        });
      });
    });
    req.on("error", (err) => {
      if (capped) {
        const ms = Math.round(performance.now() - t0);
        resolve({
          ok: false,
          status: 0,
          ms,
          body: "",
          bytes: total,
          capped: true,
          content_type: "",
          error: String(err),
        });
        return;
      }
      reject(err);
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS} ms`));
    });
    req.end();
  });
}

function shapeCheckAdvertisement(parsed) {
  // Lifted verbatim from mcp-server/src/services/wire-types.ts kindOf —
  // the goal is "does this match the NodeAdvertisement contract", not
  // "is the signature good". Two honest implementations of the contract
  // MUST agree on shape; that is the swarm trust premise.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not an object" };
  }
  const required = ["node_id", "pubkey", "endpoint_url", "signed_at"];
  const missing = required.filter((k) => typeof parsed[k] !== "string");
  if (missing.length > 0) return { ok: false, reason: `missing: ${missing.join(",")}` };
  if (typeof parsed.signature !== "string") return { ok: false, reason: "missing signature field" };
  return { ok: true, kind: "node_advertisement", node_id: parsed.node_id };
}

async function discover() {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let firstSeen = null;
    let deadlineTimer = null;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve();
    };
    try {
      browser = bonjour.find({ type: SERVICE_TYPE });
    } catch (err) {
      report.steps.discover = { ok: false, error: String(err) };
      finish();
      return;
    }
    browser.on("up", async (svc) => {
      if (firstSeen) return; // act on first hit only
      firstSeen = {
        name: svc.name,
        host: svc.host,
        port: svc.port,
        txt: svc.txt,
        seen_after_ms: Math.round(performance.now() - t0),
      };
      report.steps.discover = { ok: true, ...firstSeen };
      // First hit acquired — disarm the no-peer-seen deadline so the
      // in-flight fetch isn't raced by the timeout's own resolve().
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }

      const url = svc.txt && (svc.txt.url || svc.txt.URL);
      if (!url) {
        report.steps.fetch = { ok: false, error: "TXT record has no url field" };
        finish();
        return;
      }
      try {
        const fetchResult = await fetchUrl(url);
        report.steps.fetch = {
          ok: fetchResult.ok,
          status: fetchResult.status,
          ms: fetchResult.ms,
          content_type: fetchResult.content_type,
          body_bytes: fetchResult.body.length,
          bytes_seen: fetchResult.bytes,
          capped: fetchResult.capped === true,
        };
        if (!fetchResult.ok) {
          if (fetchResult.capped) {
            report.steps.shape = {
              ok: false,
              reason: `body exceeded self-cap (${BODY_SELF_CAP_BYTES} bytes)`,
            };
          }
          finish();
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(fetchResult.body);
        } catch (err) {
          report.steps.shape = { ok: false, error: `JSON parse: ${String(err)}` };
          finish();
          return;
        }
        report.steps.shape = shapeCheckAdvertisement(parsed);
        report.steps.total = {
          ms: Math.round(performance.now() - t0),
          within_2s_budget: Math.round(performance.now() - t0) <= 2000,
        };
      } catch (err) {
        report.steps.fetch = { ok: false, error: String(err) };
      }
      finish();
    });
    deadlineTimer = setTimeout(() => {
      report.steps.discover ??= {
        ok: false,
        timeout_ms: DISCOVER_TIMEOUT_MS,
        reason: "no peer seen before timeout",
      };
      finish();
    }, DISCOVER_TIMEOUT_MS);
  });
}

async function main() {
  bonjour = new Bonjour();
  if (MODE_PUBLISH || MODE_BOTH) {
    await startHttpServer();
    await publish();
  }
  if (MODE_DISCOVER || MODE_BOTH) {
    if (!report.service) {
      // Discover-only path needs a service stub for the report header.
      report.service = { type: SERVICE_TYPE, fqdn: `_${SERVICE_TYPE}._tcp.local` };
    }
    await discover();
  }

  if (MODE_PUBLISH) {
    report.steps.serve = { lifetime_ms: PUBLISH_LIFETIME_MS || "until-sigint" };
    await holdOpen(PUBLISH_LIFETIME_MS);
  }

  if (browser) browser.stop();
  if (publisher) publisher.stop();
  bonjour.destroy();
  if (httpServer) await new Promise((r) => httpServer.close(() => r()));

  finalize();
}

function holdOpen(ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    if (ms > 0) setTimeout(finish, ms);
  });
}

function finalize() {
  report.finished_at = new Date().toISOString();
  const verdict = [];
  if (report.steps.publish) {
    verdict.push(report.steps.publish.ok ? `publish ${report.steps.publish.ms} ms` : `publish FAILED`);
  }
  if (report.steps.discover) {
    const d = report.steps.discover;
    verdict.push(d.ok ? `discover @ ${d.seen_after_ms} ms` : `discover FAILED`);
  }
  if (report.steps.fetch) {
    const f = report.steps.fetch;
    verdict.push(f.ok ? `fetch ${f.status} in ${f.ms} ms` : `fetch FAILED`);
  }
  if (report.steps.shape) {
    verdict.push(report.steps.shape.ok ? `shape ok (${report.steps.shape.kind})` : `shape BAD: ${report.steps.shape.reason}`);
  }
  if (report.steps.total) {
    verdict.push(`total ${report.steps.total.ms} ms${report.steps.total.within_2s_budget ? " (✓ budget)" : " (✗ budget)"}`);
  }
  console.error(`[spike-mdns-fetch] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("[spike-mdns-fetch] uncaught:", err);
  process.exit(1);
});
