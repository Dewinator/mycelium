#!/usr/bin/env node
// Wave 3 mDNS spike — publisher-side wake / network-change re-announce.
//
// Context: docs/swarm-discovery-spike.md (§L1, "Failure modes on real LANs"
// — line 476): "macOS sleep / Windows fast-startup. The mDNS responder
// must re-announce on `wake` and `network-change` events. Tauri exposes
// both via its OS hooks; the sidecar listens and re-runs
// `bonjour.publish()`." That paragraph asserts a contract the
// implementation will rely on but has never been empirically tested. The
// rejoin / cold-rebrowse spike chain (commits 0b3ec74, 2ed2768) validated
// the DISCOVERER side — what happens to a long-lived browser when a
// publisher subprocess SIGKILLs and respawns. That answers "the peer
// died and came back as a fresh process." It does not answer the dual:
// what happens when the publisher process stays alive but its bonjour
// state must be torn down and reissued (laptop wakes from sleep, WiFi
// reconnects with a new IP, the HTTP listener rebinds to a new port)?
//
// Question this spike answers (one publisher, one machine, in-process):
//   When a publisher destroys its existing `Bonjour()` instance and
//   immediately creates a new one publishing the SAME instance name and
//   SAME node_id at a NEW ephemeral port — i.e. the production "wake"
//   shape — what do downstream observers see?
//
//     (1) Does a *cold-rebrowse* (fresh `Bonjour()` from a separate
//         observer) surface the new port within the same 2 s settle
//         budget the cold-rebrowse spike measured for SIGKILL+respawn?
//     (2) Does the same cold-rebrowse also surface STALE state from the
//         OS mDNS daemon — i.e. does macOS mDNSResponder keep serving
//         the dead old port to fresh browsers, leaving the implementation
//         to disambiguate by node_id+port pairs?
//     (3) Does a *long-lived* browser that observed the v1 advertisement
//         pre-wake fire any `up` events for v2 post-wake — or is it the
//         same blind spot the SIGKILL+respawn case showed?
//     (4) How long does in-process destroy()+publish() take wall-clock?
//         The implementation will call this from a Tauri OS-hook callback
//         and must not block the sidecar event loop for visible time.
//
// Why this matters: the implementation has two viable shapes for
// handling wake/network-change events. Shape A — destroy the existing
// Bonjour instance and create a fresh one with the new port; rely on
// peers' cold-rebrowse-on-eviction (the path the cold-rebrowse spike
// already validated) to re-discover the wake. Shape B — keep the
// Bonjour instance alive and somehow rebind/re-announce the existing
// service to the new port. This spike empirically validates Shape A
// and lets the implementation issue (issue 1 in docs/swarm-discovery-
// spike.md "Concrete next steps") name it as the chosen approach with
// real numbers from the wake side, not just from the SIGKILL side.
//
// Method (single process, three Bonjour instances total):
//   1. Spin up an HTTP server on ephemeral port P1 serving a mock
//      `/.well-known/mycelium-node` for stable node_id `wake-A`.
//   2. `publish_v1`: create Bonjour A1, publish `mycelium-wake-A` at P1
//      with TXT { url=http://127.0.0.1:P1/, node_id=wake-A,
//      spec_version=1.1 }. Identical shape to spike-mdns-fetch.mjs.
//   3. Start a long-lived browser (Bonjour L). Watch for instance names
//      `mycelium-wake-*` and record every `up` event timestamped against
//      both wake and start.
//   4. Wait MDNS_SETTLE_MS so the daemon has time to register.
//   5. **Cold-rebrowse #1 (pre-wake sanity)**: fresh Bonjour C1, find
//      for SERVICE_TYPE, observe COLD_SETTLE_MS, harvest. Confirm v1 at
//      P1 is visible. Record the full event log so we can detect any
//      pre-wake stale entries (there should be none).
//   6. **Wake**: destroy A1, close the HTTP server bound to P1, create
//      a new HTTP server on a fresh ephemeral port P2 (P2 ≠ P1 — the
//      whole point of the spike), create Bonjour A2, publish the same
//      `mycelium-wake-A` instance name with TXT pointing at P2. Time
//      the wall-clock cost of the destroy+republish.
//   7. Wait POST_WAKE_OBSERVE_MS — long enough that any belated up-event
//      on the long-lived browser would have fired.
//   8. **Cold-rebrowse #2 (post-wake)**: fresh Bonjour C2, same shape
//      as #1. Confirm v2 at P2 is visible; check whether any event in
//      the harvest references the dead port P1 (OS-daemon staleness
//      indicator).
//   9. Cleanup: stop both browsers, destroy both Bonjour instances
//      that are still alive, close HTTP server.
//  10. Report.
//
// What this is NOT:
//   - cross-host. Same single-Mac, single-process loopback model as the
//     rest of the spike chain. The publisher's bonjour daemon and both
//     observers share one mDNSResponder.
//   - signature verification. Mock advertisement is unsigned. Wake is a
//     transport-side event; the wire-side trust contract is unchanged.
//   - a measurement of OS sleep itself. We can't put macOS to sleep
//     from a Node spike. The "wake" we simulate is the same destroy+
//     republish call the implementation will issue from its
//     `wake`/`network-change` Tauri hook handler — that *is* the
//     publisher-side action.
//
// Output: JSON report on stdout, one-line verdict on stderr.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";

const NODE_ID = "wake-A";
const INSTANCE_NAME = `mycelium-${NODE_ID}`;
const SERVICE_TYPE = "mycelium";
const MDNS_SETTLE_MS = Number(process.env.SPIKE_WAKE_SETTLE_MS) || 4000;
// Same 2 s window as cold-rebrowse spike — that's the production budget.
const COLD_SETTLE_MS = Number(process.env.SPIKE_WAKE_COLD_SETTLE_MS) || 2000;
// Long-lived observation window after wake. Has to be long enough that
// any plausible delayed up-event would have fired. Cold-rebrowse spike
// observed 17 s after respawn with zero events; 8 s is enough for a
// definitive "no" without burning more wall-clock than necessary on a
// negative-result measurement.
const POST_WAKE_OBSERVE_MS = Number(process.env.SPIKE_WAKE_OBSERVE_MS) || 8000;
// Tiny pause after publish() before measuring — bonjour-service queues
// the multicast announce and we want it to actually go out before we
// claim "published."
const PUBLISH_GRACE_MS = 250;

const report = {
  spike: "wave-3-mdns-wake",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http",
  config: {
    node_id: NODE_ID,
    instance_name: INSTANCE_NAME,
    service_type: SERVICE_TYPE,
    mdns_settle_ms: MDNS_SETTLE_MS,
    cold_settle_ms: COLD_SETTLE_MS,
    post_wake_observe_ms: POST_WAKE_OBSERVE_MS,
    publish_grace_ms: PUBLISH_GRACE_MS,
  },
};

function startHttpServer(nodeId) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.url === "/.well-known/mycelium-node") {
        const port = server.address().port;
        const body = JSON.stringify({
          node_id: nodeId,
          pubkey: "spike-fake-pubkey",
          endpoint_url: `http://127.0.0.1:${port}/`,
          signed_at: new Date().toISOString(),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function publish(nodeId, port) {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `mycelium-${nodeId}`,
    type: SERVICE_TYPE,
    port,
    txt: {
      url: `http://127.0.0.1:${port}/`,
      node_id: nodeId,
      spec_version: "1.1",
    },
  });
  await new Promise((r) => setTimeout(r, PUBLISH_GRACE_MS));
  return { bonjour, service };
}

// Cold-rebrowse: fresh Bonjour instance, find for SERVICE_TYPE, observe
// for settleMs, then fully stop+destroy. Returns harvest (deduped by
// instance name → first-seen) plus the full event log so callers can
// detect staleness (multiple distinct ports reported under the same
// instance name).
async function coldRebrowse({ settleMs }) {
  const t0 = performance.now();
  const harvested = new Map();
  const events = [];
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    if (typeof svc.name !== "string" || !svc.name.startsWith("mycelium-wake-")) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    const elapsed = Math.round(performance.now() - t0);
    events.push({
      name: svc.name,
      node_id: nodeId,
      url,
      port: svc.port,
      t_ms: elapsed,
    });
    if (!url || !nodeId) return;
    if (!harvested.has(svc.name)) {
      harvested.set(svc.name, {
        url,
        node_id: nodeId,
        port: svc.port,
        first_seen_ms: elapsed,
      });
    }
  });
  await new Promise((r) => setTimeout(r, settleMs));
  browser.stop();
  bonjour.destroy();
  const total = Math.round(performance.now() - t0);
  return {
    harvested: Array.from(harvested.entries()).map(([name, c]) => ({
      name,
      node_id: c.node_id,
      url: c.url,
      port: c.port,
      first_seen_ms: c.first_seen_ms,
    })),
    events,
    settle_total_ms: total,
  };
}

async function main() {
  // Phase 1: initial publish at P1.
  const httpV1 = await startHttpServer(NODE_ID);
  const portV1 = httpV1.address().port;
  let bjV1 = await publish(NODE_ID, portV1);
  report.publish_v1 = {
    port: portV1,
    instance: INSTANCE_NAME,
    txt_url: `http://127.0.0.1:${portV1}/`,
  };

  // Phase 2: long-lived browser. Track everything; tag events as
  // pre-wake or post-wake by comparison against wakeAt (set in Phase 4).
  const longBonjour = new Bonjour();
  const longLivedEvents = [];
  let wakeAt = null;
  const tStart = performance.now();
  const longBrowser = longBonjour.find({ type: SERVICE_TYPE });
  longBrowser.on("up", (svc) => {
    if (typeof svc.name !== "string" || !svc.name.startsWith("mycelium-wake-")) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    const now = performance.now();
    longLivedEvents.push({
      name: svc.name,
      node_id: nodeId,
      url,
      port: svc.port,
      t_ms_from_start: Math.round(now - tStart),
      t_ms_from_wake: wakeAt === null ? null : Math.round(now - wakeAt),
      phase: wakeAt === null ? "pre_wake" : "post_wake",
    });
  });

  // Phase 3: settle then cold-rebrowse #1 to confirm v1 is visible.
  await new Promise((r) => setTimeout(r, MDNS_SETTLE_MS));

  const cold1 = await coldRebrowse({ settleMs: COLD_SETTLE_MS });
  report.cold_rebrowse_pre_wake = {
    settle_window_ms: COLD_SETTLE_MS,
    wall_time_ms: cold1.settle_total_ms,
    harvested_count: cold1.harvested.length,
    harvested: cold1.harvested,
    raw_event_count: cold1.events.length,
    sees_v1_port: cold1.harvested.some((h) => h.port === portV1),
    distinct_ports_for_instance: Array.from(
      new Set(cold1.events.filter((e) => e.name === INSTANCE_NAME).map((e) => e.port))
    ),
  };

  if (!report.cold_rebrowse_pre_wake.sees_v1_port) {
    report.aborted = `pre-wake cold-rebrowse failed to see v1 at port ${portV1}`;
    longBrowser.stop();
    longBonjour.destroy();
    bjV1.bonjour.destroy();
    await new Promise((r) => httpV1.close(() => r()));
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-wake] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Phase 4: wake. Destroy v1, close v1 HTTP listener, bring up v2 at
  // a new ephemeral port. Time the wall-clock cost.
  const tWake0 = performance.now();
  bjV1.bonjour.destroy();
  bjV1 = null;
  await new Promise((r) => httpV1.close(() => r()));
  const httpV2 = await startHttpServer(NODE_ID);
  const portV2 = httpV2.address().port;
  if (portV2 === portV1) {
    // Vanishingly unlikely on a healthy system, but if the kernel
    // reassigns the same ephemeral port the spike's "did the new port
    // surface" check becomes a tautology. Bail loudly.
    report.aborted = `kernel reassigned the same ephemeral port (${portV2}); rerun the spike`;
    longBrowser.stop();
    longBonjour.destroy();
    await new Promise((r) => httpV2.close(() => r()));
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-wake] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const bjV2 = await publish(NODE_ID, portV2);
  const tWake1 = performance.now();
  wakeAt = tWake1;
  report.wake = {
    at: new Date().toISOString(),
    old_port: portV1,
    new_port: portV2,
    same_node_id: NODE_ID,
    same_instance_name: INSTANCE_NAME,
    destroy_to_republish_ms: Math.round(tWake1 - tWake0),
  };

  // Phase 5: long-lived observation post-wake.
  await new Promise((r) => setTimeout(r, POST_WAKE_OBSERVE_MS));

  // Phase 6: cold-rebrowse #2 — does the new state surface?
  const cold2 = await coldRebrowse({ settleMs: COLD_SETTLE_MS });
  const distinctPortsForInstance2 = Array.from(
    new Set(cold2.events.filter((e) => e.name === INSTANCE_NAME).map((e) => e.port))
  );
  report.cold_rebrowse_post_wake = {
    settle_window_ms: COLD_SETTLE_MS,
    wall_time_ms: cold2.settle_total_ms,
    harvested_count: cold2.harvested.length,
    harvested: cold2.harvested,
    raw_event_count: cold2.events.length,
    sees_v2_port: cold2.harvested.some((h) => h.port === portV2)
      || cold2.events.some((e) => e.port === portV2),
    sees_stale_v1_port: cold2.events.some((e) => e.port === portV1),
    distinct_ports_for_instance: distinctPortsForInstance2,
    raw_events: cold2.events,
  };

  // Phase 7: separate the long-lived events into pre/post-wake buckets.
  const longLivedPre = longLivedEvents.filter((e) => e.phase === "pre_wake");
  const longLivedPost = longLivedEvents.filter((e) => e.phase === "post_wake");
  report.long_lived_browser = {
    total_up_events: longLivedEvents.length,
    pre_wake_count: longLivedPre.length,
    post_wake_count: longLivedPost.length,
    pre_wake_events: longLivedPre,
    post_wake_events: longLivedPost,
    note:
      "If post_wake_count is zero, the long-lived browser shows the same blind spot as the SIGKILL+respawn case (spike-mdns-rejoin / spike-mdns-cold-rebrowse, commits 0b3ec74 and 2ed2768) — implementation must rely on cold-rebrowse on the discoverer side to surface the new port.",
  };

  // Cleanup.
  longBrowser.stop();
  longBonjour.destroy();
  bjV2.bonjour.destroy();
  await new Promise((r) => httpV2.close(() => r()));

  report.finished_at = new Date().toISOString();

  // Verdict — clean = pre-wake cold sees v1, post-wake cold sees v2,
  // post-wake cold does NOT see stale v1, and destroy+republish wall-time
  // is reasonable (<1 s; the actual publish operation is sub-50 ms in
  // practice but allow slack for HTTP server bring-up). The long-lived
  // browser's behaviour is reported but does not gate clean — it's an
  // empirical observation, not a contract.
  const destroyRepublishOk = report.wake.destroy_to_republish_ms < 1000;
  const clean =
    !report.aborted &&
    report.cold_rebrowse_pre_wake.sees_v1_port &&
    report.cold_rebrowse_post_wake.sees_v2_port &&
    !report.cold_rebrowse_post_wake.sees_stale_v1_port &&
    destroyRepublishOk;

  const verdict = [
    `pre-wake cold sees v1 (port ${portV1}): ${report.cold_rebrowse_pre_wake.sees_v1_port}`,
    `wake destroy+republish: ${report.wake.destroy_to_republish_ms} ms`,
    `post-wake cold sees v2 (port ${portV2}): ${report.cold_rebrowse_post_wake.sees_v2_port}`,
    `post-wake cold sees stale v1: ${report.cold_rebrowse_post_wake.sees_stale_v1_port}`,
    `long-lived up-events post-wake: ${longLivedPost.length}`,
    clean ? "OK" : (report.aborted ?? "FAIL"),
  ];
  console.error(`[spike-mdns-wake] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));
  process.exit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-wake] uncaught:", err);
  process.exit(1);
});
