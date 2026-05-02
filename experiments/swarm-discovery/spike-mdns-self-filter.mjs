#!/usr/bin/env node
// Wave 3 mDNS spike — self-discovery filter under the production model.
//
// Every previous spike in this chain split publisher and discoverer into
// separate processes, so a "node sees itself on the wire" never came up.
// Production is the opposite: every mycelium node both *publishes* its own
// advertisement AND *browses* for peers in the same process. The macOS
// mDNS responder happily delivers a node's own announcements back to its
// own browser — that is a feature of the protocol, not a bug — so without
// a filter, every node would try to fetch its own /.well-known/mycelium-node
// in a tight self-loop on startup and re-add itself as a "peer".
//
// What this validates that the prior spikes do NOT:
//   - that a single process running both `bonjour.publish()` and
//     `bonjour.find()` actually sees its own service in the browser
//     (the "default-on" self-echo behaviour we're filtering out);
//   - that the canonical filter — `txt.node_id !== own_node_id` — is
//     sufficient: stable across restarts, survives port changes, doesn't
//     depend on address matching (link-local + public IPv6 + IPv4 all
//     show up on a real Mac, see report-mdns-fanout.json);
//   - that with the filter on, a real remote peer (a separate child
//     process publishing a different node_id) is still discovered AND
//     fetched, while self is correctly skipped — i.e. the filter is a
//     *narrow* skip, not a load-bearing whole-flow gate that could mask
//     a broken discovery path.
//
// What this is NOT:
//   - cross-host (still single-machine — see open items in
//     docs/swarm-discovery-spike.md);
//   - signature verification (mock signatures, same as siblings);
//   - a stress test of the filter under name collisions (a future spike
//     could explore "what if two nodes pick the same node_id" but that
//     is a key-management question, not a discovery one).
//
// Output: JSON report on stdout, one-line verdict on stderr — matches
// spike-mdns.mjs / spike-mdns-fetch.mjs / spike-mdns-fanout.mjs convention.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REMOTE_PUBLISHER_SPIKE = resolvePath(__dirname, "spike-mdns-fetch.mjs");

const SERVICE_TYPE = "mycelium";
const LOOPBACK_HOST = "127.0.0.1";
const DISCOVER_WINDOW_MS = Number(process.env.SPIKE_SELF_WINDOW_MS) || 5000;
const REMOTE_LIFETIME_MS = DISCOVER_WINDOW_MS + 2000;
const FETCH_TIMEOUT_MS = 2_000;
const BODY_SELF_CAP_BYTES = 64 * 1024;
const OWN_NODE_ID = `spike-self-${process.pid}`;
const OWN_PUBKEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const report = {
  spike: "wave-3-mdns-self-filter",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http + node:child_process",
  config: {
    own_node_id: OWN_NODE_ID,
    discover_window_ms: DISCOVER_WINDOW_MS,
    remote_lifetime_ms: REMOTE_LIFETIME_MS,
    body_self_cap_bytes: BODY_SELF_CAP_BYTES,
  },
};

function buildOwnAdvertisement(port) {
  return {
    node_id: OWN_NODE_ID,
    pubkey: OWN_PUBKEY_B64,
    display_name: "spike-mdns-self-filter",
    endpoint_url: `http://${LOOPBACK_HOST}:${port}`,
    spec_version: "1.1",
    signed_at: new Date().toISOString(),
    signature: "MOCK-NOT-A-REAL-ED25519-SIGNATURE",
  };
}

function startOwnHttpServer() {
  return new Promise((resolve, reject) => {
    let port = 0;
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/mycelium-node" && req.method === "GET") {
        const body = JSON.stringify(buildOwnAdvertisement(port));
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
    });
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      port = server.address().port;
      resolve({ server, port });
    });
  });
}

function spawnRemotePublisher() {
  // Reuses spike-mdns-fetch.mjs --publish: child gets its own pid →
  // its own FAKE_NODE_ID = `spike-${pid}`, distinct from our OWN_NODE_ID.
  return spawn(process.execPath, [REMOTE_PUBLISHER_SPIKE, "--publish"], {
    env: { ...process.env, SPIKE_PUBLISH_MS: String(REMOTE_LIFETIME_MS) },
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
  // 1. Start our own HTTP server + bonjour.publish() — the "self" half.
  const { server: ownServer, port: ownPort } = await startOwnHttpServer();
  const ownAdvUrl = `http://${LOOPBACK_HOST}:${ownPort}/.well-known/mycelium-node`;
  report.self = {
    own_node_id: OWN_NODE_ID,
    own_http_port: ownPort,
    own_adv_url: ownAdvUrl,
  };

  const bonjour = new Bonjour();
  const tPublish = performance.now();
  const publisher = bonjour.publish({
    name: `mycelium-${OWN_NODE_ID}`,
    type: SERVICE_TYPE,
    port: ownPort,
    txt: { url: ownAdvUrl, node_id: OWN_NODE_ID, spec: "v1" },
  });
  await new Promise((r) => setTimeout(r, 250));
  report.self.publish_ms = Math.round(performance.now() - tPublish);

  // 2. Spawn one remote publisher (separate process, distinct node_id).
  const tSpawn = performance.now();
  const remote = spawnRemotePublisher();
  report.remote = {
    pid: remote.pid ?? null,
    spawn_ms: Math.round(performance.now() - tSpawn),
  };
  await new Promise((r) => setTimeout(r, 750)); // let remote finish publishing

  // 3. Browse — we MUST see ourselves on the wire if the spike's premise
  //    holds. If we don't, the filter conversation is moot and that itself
  //    is the finding.
  const seen = new Map();
  const tDiscover = performance.now();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    if (typeof svc.name !== "string" || !svc.name.startsWith("mycelium-")) return;
    if (!svc.txt || typeof svc.txt.url !== "string") return;
    const existing = seen.get(svc.name);
    if (existing) {
      existing.up_events += 1;
      return;
    }
    seen.set(svc.name, {
      name: svc.name,
      port: svc.port,
      txt: svc.txt,
      first_seen_ms: Math.round(performance.now() - tDiscover),
      up_events: 1,
    });
  });

  await new Promise((r) => setTimeout(r, DISCOVER_WINDOW_MS));
  browser.stop();

  const services = Array.from(seen.values());
  const selfHits = services.filter((s) => s.txt.node_id === OWN_NODE_ID);
  const peerHits = services.filter((s) => s.txt.node_id !== OWN_NODE_ID);
  report.discover = {
    total_seen: services.length,
    self_seen: selfHits.length,
    peers_seen: peerHits.length,
    services,
  };

  // 4. Apply the canonical filter and fetch only what survives.
  const filtered = peerHits;
  const tFetch = performance.now();
  const fetches = await Promise.all(
    filtered.map(async (s) => {
      const r = await fetchUrl(s.txt.url);
      let shape = null;
      let txtBodyMatch = null;
      if (r.ok) {
        try {
          const parsed = JSON.parse(r.body);
          shape = shapeCheckAdvertisement(parsed);
          if (shape.ok) txtBodyMatch = parsed.node_id === s.txt.node_id;
        } catch (e) {
          shape = { ok: false, error: `JSON parse: ${String(e)}` };
        }
      }
      return {
        name: s.name,
        url: s.txt.url,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        bytes: r.bytes,
        shape,
        txt_node_id_matches_body: txtBodyMatch,
      };
    })
  );
  report.filter = {
    rule: "txt.node_id !== own_node_id",
    skipped_self: selfHits.length,
    fetched_peers: filtered.length,
    parallel_total_ms: Math.round(performance.now() - tFetch),
    results: fetches,
    all_fetched_ok: fetches.length > 0 && fetches.every((f) => f.ok && f.shape && f.shape.ok),
    all_txt_body_match:
      fetches.length > 0 && fetches.every((f) => f.txt_node_id_matches_body === true),
    no_self_fetch: !fetches.some((f) => {
      // A self-fetch would have come back with our own node_id in the body.
      try {
        return f.shape && f.shape.ok && f.shape.node_id === OWN_NODE_ID;
      } catch {
        return false;
      }
    }),
  };

  // 5. Tear down everything cleanly.
  publisher.stop?.(() => {});
  bonjour.destroy();
  ownServer.close();
  if (remote.exitCode === null && !remote.killed) remote.kill("SIGTERM");
  await new Promise((resolve) => {
    if (remote.exitCode !== null) return resolve();
    remote.once("exit", () => resolve());
  });

  const verdict = [
    `self_seen ${selfHits.length}`,
    `peers ${peerHits.length}`,
    `skipped_self ${report.filter.skipped_self}`,
    `fetched ${report.filter.fetched_peers}`,
    report.filter.all_fetched_ok ? "all peer-shape ✓" : "PEER FETCH FAIL",
    report.filter.no_self_fetch ? "no self-fetch ✓" : "SELF-FETCH LEAKED",
  ];
  console.error(`[spike-mdns-self-filter] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  // Spike passes when:
  //   - we DID see ourselves (otherwise the filter is irrelevant — the
  //     stack already isolates us);
  //   - we saw at least one real peer;
  //   - the filter skipped exactly self_seen entries;
  //   - the surviving fetches succeeded;
  //   - none of those fetches came back with our own node_id (no leak).
  const ok =
    selfHits.length >= 1 &&
    peerHits.length >= 1 &&
    report.filter.no_self_fetch &&
    report.filter.all_fetched_ok &&
    report.filter.all_txt_body_match;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-self-filter] uncaught:", err);
  process.exit(1);
});
