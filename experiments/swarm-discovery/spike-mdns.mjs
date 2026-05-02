#!/usr/bin/env node
// Wave 3 mDNS spike — validate bonjour-service for _mycelium._tcp.local.
//
// docs/swarm-discovery-spike.md picks `bonjour-service` (pure-JS, zero native
// deps) over the alternative `mdns` (binds to system Avahi/Bonjour headers,
// breaks the "one Tauri sidecar artifact per OS" promise). This script is the
// cheapest possible empirical check that the pick holds up:
//
//   - can we publish a `_mycelium._tcp.local` service with a TXT record
//     payload that carries the NodeAdvertisement URL pointer described in the
//     spike (§"mDNS service name", payload is a URL pointer, not the
//     advertisement itself);
//   - can a second process on the same loopback discover it within the
//     spike's "≤2 s typical" budget;
//   - does the platform's UDP multicast stack tolerate a foreign responder
//     coexisting with the OS mDNSResponder (macOS) / Avahi (Linux) /
//     iexplore (Windows).
//
// Modes:
//   --publish      run as responder only (advertise the service, never exit)
//   --discover     run as browser only (log discoveries, exit after timeout)
//   default        run both in-process (publishes once, discovers, prints,
//                  exits). Cheapest single-machine smoke test.
//
// Output: a JSON report on stdout (same shape as the native-pg / native-llm
// spikes), plus a one-line verdict on stderr.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { hostname } from "node:os";

const args = new Set(process.argv.slice(2));
const MODE_PUBLISH = args.has("--publish");
const MODE_DISCOVER = args.has("--discover");
const MODE_BOTH = !MODE_PUBLISH && !MODE_DISCOVER;

const SERVICE_TYPE = "mycelium";
const SERVICE_PORT = 8787; // mirrors the existing dashboard/HTTP port
const DISCOVER_TIMEOUT_MS = MODE_DISCOVER ? 30_000 : 5_000;
const FAKE_NODE_ID = `spike-${process.pid}`;
const FAKE_ADV_URL = `http://${hostname()}.local:${SERVICE_PORT}/.well-known/mycelium-node`;

const report = {
  spike: "wave-3-mdns",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service",
  mode: MODE_BOTH ? "both" : MODE_PUBLISH ? "publish-only" : "discover-only",
  service: {
    type: SERVICE_TYPE,
    fqdn: `_${SERVICE_TYPE}._tcp.local`,
    port: SERVICE_PORT,
    txt: { url: FAKE_ADV_URL, node_id: FAKE_NODE_ID, spec: "v1" },
  },
  steps: {},
};

let bonjour;
let publisher;
let browser;

async function publish() {
  const t0 = performance.now();
  try {
    publisher = bonjour.publish({
      name: `mycelium-${FAKE_NODE_ID}`,
      type: SERVICE_TYPE,
      port: SERVICE_PORT,
      txt: report.service.txt,
    });
    // bonjour-service `publish` is fire-and-forget; give the OS time to bind.
    await new Promise((resolve) => setTimeout(resolve, 250));
    report.steps.publish = { ok: true, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    report.steps.publish = { ok: false, error: String(err) };
  }
}

async function discover() {
  const t0 = performance.now();
  const found = [];
  return new Promise((resolve) => {
    try {
      browser = bonjour.find({ type: SERVICE_TYPE });
    } catch (err) {
      report.steps.discover = { ok: false, error: String(err) };
      resolve();
      return;
    }
    browser.on("up", (svc) => {
      found.push({
        name: svc.name,
        host: svc.host,
        addresses: svc.addresses,
        port: svc.port,
        txt: svc.txt,
        seen_after_ms: Math.round(performance.now() - t0),
      });
      // In single-process mode, we can resolve as soon as we see ourselves.
      if (MODE_BOTH && found.length >= 1) {
        report.steps.discover = {
          ok: true,
          count: found.length,
          first_seen_ms: found[0].seen_after_ms,
          peers: found,
        };
        resolve();
      }
    });
    browser.on("down", (svc) => {
      // Logged but not blocking — relevant for v2 churn handling.
      report.events ??= [];
      report.events.push({ kind: "down", name: svc.name });
    });
    setTimeout(() => {
      report.steps.discover ??= {
        ok: found.length > 0,
        count: found.length,
        peers: found,
        timeout_ms: DISCOVER_TIMEOUT_MS,
      };
      resolve();
    }, DISCOVER_TIMEOUT_MS);
  });
}

async function main() {
  bonjour = new Bonjour();
  if (MODE_PUBLISH || MODE_BOTH) await publish();
  if (MODE_DISCOVER || MODE_BOTH) await discover();

  // Clean shutdown — leaving an mDNS responder dangling pollutes the LAN.
  if (browser) browser.stop();
  if (publisher) publisher.stop();
  bonjour.destroy();

  finalize();
}

function finalize() {
  report.finished_at = new Date().toISOString();
  const verdict = [];
  if (report.steps.publish) {
    verdict.push(report.steps.publish.ok ? `publish ${report.steps.publish.ms} ms` : `publish FAILED`);
  }
  if (report.steps.discover) {
    const d = report.steps.discover;
    verdict.push(
      d.ok
        ? `discover ${d.count} peer${d.count === 1 ? "" : "s"}${d.first_seen_ms != null ? ` @ ${d.first_seen_ms} ms` : ""}`
        : `discover FAILED (${d.count ?? 0})`
    );
  }
  console.error(`[spike-mdns] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error("[spike-mdns] uncaught:", err);
  process.exit(1);
});
