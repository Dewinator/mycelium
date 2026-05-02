#!/usr/bin/env node
// Wave 3 mDNS+fetch spike — multi-publisher fan-out.
//
// `spike-mdns-fetch.mjs` validated the pointer→fetch loop with exactly one
// publisher and one discoverer. The design spike (docs/swarm-discovery-spike.md)
// describes use cases that are inherently multi-peer:
//   - "Reed and his partner both run mycelium" (N=2 on home WiFi);
//   - implicit office-WiFi case (N≈5–20);
//   - the threat-model section caps the candidate-URL queue at 256 per
//     discovery cycle without any evidence about how `bonjour-service`
//     behaves at the *small* N that real swarms actually have.
//
// What this validates that spike-mdns-fetch.mjs does NOT:
//   - that `bonjour-service` surfaces N concurrent publishers on the same
//     LAN as N distinct `up` events with stable, dedupable instance names —
//     i.e. the discoverer can tell three peers apart, not see one peer
//     three times;
//   - that a single discoverer can fan-out N parallel HTTPS-shaped fetches
//     and shape-check N distinct NodeAdvertisements inside the discovery
//     window without serialising them;
//   - that each peer's TXT-advertised `node_id` matches the `node_id`
//     inside the body it serves — the cross-channel consistency check that
//     a real implementation would use to detect TXT/body mismatch as the
//     first cheap filter before signature verification.
//
// What this is NOT:
//   - cross-host. The publishers are subprocesses on this Mac, not
//     separate machines. Cross-host is still the open item named in
//     docs/swarm-discovery-spike.md.
//   - a flood test (N=1000). The 256-cap is a defensive ceiling; the
//     missing evidence is the practical small-N case, not the pathological
//     case. A flood spike is a separate piece of work.
//   - signature verification. The publishers serve mock advertisements
//     with placeholder signatures, same as the parent spike.
//
// Output: JSON report on stdout, one-line verdict on stderr — matches
// spike-mdns.mjs / spike-mdns-fetch.mjs / spike-fetch-hostile.mjs.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLISHER_SPIKE = resolvePath(__dirname, "spike-mdns-fetch.mjs");

const PUBLISHER_COUNT = Number(process.env.SPIKE_FANOUT_N) || 3;
const DISCOVER_WINDOW_MS = Number(process.env.SPIKE_FANOUT_WINDOW_MS) || 5000;
// Children must outlive the discovery window so they don't disappear
// mid-fetch and skew the parallel-fetch timing measurement.
const PUBLISHER_LIFETIME_MS = DISCOVER_WINDOW_MS + 2000;
const FETCH_TIMEOUT_MS = 2_000;
const BODY_SELF_CAP_BYTES = 64 * 1024;
const SERVICE_TYPE = "mycelium";

const report = {
  spike: "wave-3-mdns-fanout",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http + node:child_process",
  config: {
    publishers: PUBLISHER_COUNT,
    discover_window_ms: DISCOVER_WINDOW_MS,
    publisher_lifetime_ms: PUBLISHER_LIFETIME_MS,
    body_self_cap_bytes: BODY_SELF_CAP_BYTES,
  },
};

function spawnPublisher() {
  // Reuses spike-mdns-fetch.mjs --publish: each child gets its own pid →
  // its own FAKE_NODE_ID = `spike-${pid}` → its own service instance name
  // and ephemeral HTTP port. SPIKE_PUBLISH_MS gives the child a self-
  // termination timer in case our SIGTERM doesn't land cleanly.
  return spawn(process.execPath, [PUBLISHER_SPIKE, "--publish"], {
    env: { ...process.env, SPIKE_PUBLISH_MS: String(PUBLISHER_LIFETIME_MS) },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chunks = [];
    let total = 0;
    let capped = false;
    const req = httpRequest(url, { method: "GET" }, (res) => {
      res.on("data", (c) => {
        if (capped) return;
        total += c.length;
        if (total > BODY_SELF_CAP_BYTES) {
          capped = true;
          req.destroy(new Error(`body self-cap reached at ${total} bytes`));
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
        });
      });
    });
    req.on("error", (err) => {
      const ms = Math.round(performance.now() - t0);
      resolve({
        ok: false,
        status: 0,
        ms,
        body: "",
        bytes: total,
        capped,
        error: String(err),
      });
    });
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`fetch timeout after ${FETCH_TIMEOUT_MS} ms`));
    });
    req.end();
  });
}

function shapeCheckAdvertisement(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "not an object" };
  }
  const required = ["node_id", "pubkey", "endpoint_url", "signed_at", "signature"];
  const missing = required.filter((k) => typeof parsed[k] !== "string");
  if (missing.length > 0) return { ok: false, reason: `missing: ${missing.join(",")}` };
  return { ok: true, node_id: parsed.node_id };
}

async function main() {
  const tSpawn = performance.now();
  const children = [];
  for (let i = 0; i < PUBLISHER_COUNT; i++) {
    children.push(spawnPublisher());
  }
  report.spawn = {
    children_pids: children.map((c) => c.pid ?? null),
    spawn_ms: Math.round(performance.now() - tSpawn),
  };

  // Give children ~750 ms to start their HTTP server + finish bonjour.publish().
  // The single-publisher spike measured ~250 ms publish completion; 750 ms is
  // 3× that to absorb cross-process variance for N children racing each other.
  await new Promise((r) => setTimeout(r, 750));

  const bonjour = new Bonjour();
  const seen = new Map(); // service name → { firstSeenMs, upCount, svc }
  const tDiscover = performance.now();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    const existing = seen.get(svc.name);
    if (existing) {
      existing.upCount += 1;
      return;
    }
    seen.set(svc.name, {
      firstSeenMs: Math.round(performance.now() - tDiscover),
      upCount: 1,
      svc: {
        name: svc.name,
        host: svc.host,
        port: svc.port,
        addresses: svc.addresses ?? [],
        txt: svc.txt ?? {},
      },
    });
  });

  await new Promise((r) => setTimeout(r, DISCOVER_WINDOW_MS));

  browser.stop();
  bonjour.destroy();

  const services = Array.from(seen.entries()).map(([name, v]) => ({
    name,
    host: v.svc.host,
    port: v.svc.port,
    addresses: v.svc.addresses,
    txt: v.svc.txt,
    first_seen_ms: v.firstSeenMs,
    up_events: v.upCount,
  }));
  // Filter to services we recognise as our own publishers — `_mycelium._tcp`
  // is unique to this spike, but a stray instance from a previous interrupted
  // run could in principle linger if the child wasn't reaped. Both filters
  // (name prefix and TXT shape) must hit.
  const ours = services.filter(
    (s) =>
      typeof s.name === "string" &&
      s.name.startsWith("mycelium-spike-") &&
      s.txt &&
      typeof s.txt.url === "string"
  );
  report.discover = {
    window_ms: DISCOVER_WINDOW_MS,
    services_seen_total: services.length,
    services_seen_ours: ours.length,
    expected: PUBLISHER_COUNT,
    duplicate_up_events: services.reduce(
      (sum, s) => sum + Math.max(0, s.up_events - 1),
      0
    ),
    services: ours,
  };

  const tFetch = performance.now();
  const fetches = await Promise.all(
    ours.map(async (s) => {
      const url = s.txt && (s.txt.url || s.txt.URL);
      if (!url) return { name: s.name, ok: false, error: "no TXT url" };
      const r = await fetchUrl(url);
      let shape = null;
      let txtBodyNodeIdMatch = null;
      if (r.ok) {
        try {
          const parsed = JSON.parse(r.body);
          shape = shapeCheckAdvertisement(parsed);
          if (shape.ok && s.txt && typeof s.txt.node_id === "string") {
            txtBodyNodeIdMatch = parsed.node_id === s.txt.node_id;
          }
        } catch (e) {
          shape = { ok: false, error: `JSON parse: ${String(e)}` };
        }
      }
      return {
        name: s.name,
        url,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        bytes: r.bytes,
        capped: r.capped,
        shape,
        txt_node_id_matches_body: txtBodyNodeIdMatch,
        error: r.error,
      };
    })
  );
  report.fetch = {
    parallel_total_ms: Math.round(performance.now() - tFetch),
    max_fetch_ms: Math.max(0, ...fetches.map((f) => f.ms ?? 0)),
    sum_fetch_ms: fetches.reduce((s, f) => s + (f.ms ?? 0), 0),
    all_ok: fetches.length > 0 && fetches.every((f) => f.ok && f.shape && f.shape.ok),
    all_txt_body_node_id_match:
      fetches.length > 0 && fetches.every((f) => f.txt_node_id_matches_body === true),
    results: fetches,
  };

  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGTERM");
  }
  await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null) return resolve();
          c.once("exit", () => resolve());
        })
    )
  );

  report.totals = {
    all_seen: ours.length === PUBLISHER_COUNT,
    all_fetched_ok: report.fetch.all_ok,
    all_txt_body_match: report.fetch.all_txt_body_node_id_match,
    max_first_seen_ms: ours.length
      ? Math.max(...ours.map((s) => s.first_seen_ms))
      : null,
    parallel_speedup_vs_serial:
      report.fetch.sum_fetch_ms && report.fetch.parallel_total_ms
        ? Number((report.fetch.sum_fetch_ms / report.fetch.parallel_total_ms).toFixed(2))
        : null,
  };
  report.finished_at = new Date().toISOString();

  const verdict = [
    `spawn ${report.spawn.spawn_ms} ms`,
    `seen ${ours.length}/${PUBLISHER_COUNT}` +
      (report.discover.duplicate_up_events
        ? ` (${report.discover.duplicate_up_events} dup up events)`
        : ""),
    ours.length ? `max first-seen ${report.totals.max_first_seen_ms} ms` : null,
    `parallel fetch ${report.fetch.parallel_total_ms} ms (max ${report.fetch.max_fetch_ms} ms)`,
    report.fetch.all_ok ? "all shape-ok" : "FETCH/SHAPE issues",
    report.fetch.all_txt_body_node_id_match ? "TXT↔body node_id ✓" : "TXT/body mismatch",
  ].filter(Boolean);
  console.error(`[spike-mdns-fanout] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(
    report.totals.all_seen && report.totals.all_fetched_ok && report.totals.all_txt_body_match
      ? 0
      : 1
  );
}

main().catch((err) => {
  console.error("[spike-mdns-fanout] uncaught:", err);
  process.exit(1);
});
