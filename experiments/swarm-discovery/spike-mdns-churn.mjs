#!/usr/bin/env node
// Wave 3 mDNS spike — publisher churn / liveness.
//
// The earlier spikes proved discovery in steady state — N publishers all
// alive, browser sees them all, fetch loop closes. The design doc
// (docs/swarm-discovery-spike.md) names two consequences that depend on
// peers *leaving*:
//   - the operator dashboard needs a "this peer is offline" state
//     ("Discovery on the dashboard" — open question 4);
//   - the wake/network-change re-announce hook in §L1 only matters if the
//     discoverer treats absence as eviction-worthy.
// Neither was empirically validated. The implementation can't decide
// "trust bonjour-service `down` events" vs "build our own TTL-based
// eviction" without evidence about what the library actually surfaces
// when a publisher disappears.
//
// What this validates:
//   - whether `bonjour-service`'s browser emits a `down` event when a
//     publisher process exits via SIGKILL (the realistic crash case — no
//     goodbye packet is sent because Node never gets to run cleanup);
//   - the timing: how long after process exit does `down` arrive, if at
//     all? This determines whether the discoverer needs its own TTL on
//     top of the library, or whether bonjour-service alone is enough for
//     a "peer offline within X seconds" UX commitment;
//   - whether killing M of N publishers leaves the browser's seen-set in
//     a consistent state (only the survivors remain, no ghosts).
//
// Method:
//   1. Spawn N=3 publishers (reusing spike-mdns-fetch.mjs --publish), each
//      with its own pid → its own `node_id` and instance name.
//   2. Browse `_mycelium._tcp.local`, log every `up`/`down` event with a
//      timestamp relative to the start of discovery.
//   3. Wait until all N are seen `up`.
//   4. SIGKILL every publisher at once. SIGKILL not SIGTERM because
//      `spike-mdns-fetch.mjs` has no signal handler that calls
//      `service.stop()` — both signals would look identical to the
//      browser, but SIGKILL is the explicit "definitely no goodbye"
//      contract and matches a real crash / network-cable-pulled scenario.
//   5. Observe the browser for an OBSERVE_AFTER_KILL_MS window, recording
//      every event. Report final seen-set.
//
// What this is NOT:
//   - a clean-shutdown test. A separate spike could check whether
//     `service.stop()` before exit produces a faster `down` event. That's
//     useful for the wake-hook design but is a follow-up — the realistic
//     UX failure mode is "laptop closed, no goodbye sent", which is what
//     this spike covers.
//   - cross-host. Single Mac, three subprocesses on loopback. Cross-host
//     is still the open item in the design doc.
//   - re-announce on wake. That belongs in a Tauri-shell spike, not in
//     the bonjour-service-only loop.
//
// Output: JSON report on stdout, one-line verdict on stderr.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLISHER_SPIKE = resolvePath(__dirname, "spike-mdns-fetch.mjs");

const PUBLISHER_COUNT = Number(process.env.SPIKE_CHURN_N) || 3;
// Settle window: time for all N to complete bonjour.publish() and for our
// browser to see them. The fanout spike measured max first-seen at ~625 ms
// for N=3 and ~1088 ms for N=10 — we wait long enough that "didn't see all
// N" means a real failure, not a race.
const SETTLE_WINDOW_MS = Number(process.env.SPIKE_CHURN_SETTLE_MS) || 4000;
// Observe window after SIGKILL: long enough to credibly answer "does
// bonjour-service emit `down` from TTL alone?" — RFC 6762 allows TTLs up
// to several minutes but most service-discovery libraries use much shorter
// values for active services. 15 s gives us a clear empirical signal
// without holding the spike open for a UX-meaningful duration. If `down`
// hasn't fired in 15 s, the implementation needs its own TTL/heartbeat.
const OBSERVE_AFTER_KILL_MS = Number(process.env.SPIKE_CHURN_OBSERVE_MS) || 15_000;
// Children outlive the discovery + observe window so they don't disappear
// before we've SIGKILLed them ourselves.
const PUBLISHER_LIFETIME_MS = SETTLE_WINDOW_MS + OBSERVE_AFTER_KILL_MS + 5000;
const SERVICE_TYPE = "mycelium";

const report = {
  spike: "wave-3-mdns-churn",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:child_process",
  config: {
    publishers: PUBLISHER_COUNT,
    settle_window_ms: SETTLE_WINDOW_MS,
    observe_after_kill_ms: OBSERVE_AFTER_KILL_MS,
    kill_signal: "SIGKILL",
  },
};

function spawnPublisher() {
  return spawn(process.execPath, [PUBLISHER_SPIKE, "--publish"], {
    env: { ...process.env, SPIKE_PUBLISH_MS: String(PUBLISHER_LIFETIME_MS) },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function main() {
  const events = []; // { kind: 'up'|'down', name, t_ms_from_discover_start, t_ms_from_kill?, instance }
  const seen = new Map(); // service name → { firstSeenMs, lastEventKind, lastEventMs }

  // Phase 1: spawn publishers.
  const tSpawn = performance.now();
  const children = [];
  for (let i = 0; i < PUBLISHER_COUNT; i++) {
    children.push(spawnPublisher());
  }
  report.spawn = {
    children_pids: children.map((c) => c.pid ?? null),
    spawn_ms: Math.round(performance.now() - tSpawn),
  };
  // Brief pause to let children's HTTP servers + bonjour.publish() complete
  // before we start browsing — same rationale as fanout spike (~750 ms is
  // ~3× the single-publisher publish latency).
  await new Promise((r) => setTimeout(r, 750));

  // Phase 2: start the browser, settle.
  const bonjour = new Bonjour();
  const tDiscover = performance.now();
  let tKill = null; // set when SIGKILL is sent
  const browser = bonjour.find({ type: SERVICE_TYPE });

  const recordEvent = (kind, svc) => {
    const now = performance.now();
    const tFromDiscover = Math.round(now - tDiscover);
    const tFromKill = tKill === null ? null : Math.round(now - tKill);
    if (typeof svc.name !== "string") return;
    if (!svc.name.startsWith("mycelium-spike-")) return; // only our publishers
    events.push({
      kind,
      name: svc.name,
      t_ms_from_discover_start: tFromDiscover,
      t_ms_from_kill: tFromKill,
      port: svc.port,
      txt_node_id: svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null,
    });
    const existing = seen.get(svc.name);
    if (kind === "up") {
      if (!existing) {
        seen.set(svc.name, {
          firstSeenMs: tFromDiscover,
          lastEventKind: "up",
          lastEventMs: tFromDiscover,
          downSeen: false,
          downAtMs: null,
        });
      } else {
        existing.lastEventKind = "up";
        existing.lastEventMs = tFromDiscover;
      }
    } else {
      if (existing) {
        existing.lastEventKind = "down";
        existing.lastEventMs = tFromDiscover;
        existing.downSeen = true;
        existing.downAtMs = tFromDiscover;
      } else {
        // `down` without a prior `up` — record but don't synthesize an entry
        // because we never confirmed it was ours.
      }
    }
  };

  browser.on("up", (svc) => recordEvent("up", svc));
  browser.on("down", (svc) => recordEvent("down", svc));

  await new Promise((r) => setTimeout(r, SETTLE_WINDOW_MS));

  const seenAtSettleEnd = Array.from(seen.entries())
    .filter(([, v]) => !v.downSeen)
    .map(([name]) => name);
  report.settle = {
    window_ms: SETTLE_WINDOW_MS,
    expected: PUBLISHER_COUNT,
    seen_alive: seenAtSettleEnd.length,
    all_seen: seenAtSettleEnd.length === PUBLISHER_COUNT,
    max_first_seen_ms:
      seenAtSettleEnd.length > 0
        ? Math.max(...seenAtSettleEnd.map((n) => seen.get(n).firstSeenMs))
        : null,
  };

  if (!report.settle.all_seen) {
    // Don't continue — the churn measurement only makes sense if we
    // observed all N alive first. Bail with a clear failure.
    browser.stop();
    bonjour.destroy();
    for (const c of children) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `only saw ${seenAtSettleEnd.length}/${PUBLISHER_COUNT} publishers in settle window`;
    report.events = events;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-churn] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Phase 3: SIGKILL all publishers at once. Record exactly when, so
  // every subsequent `down` event has a measurable t_ms_from_kill.
  tKill = performance.now();
  const killTimeIso = new Date().toISOString();
  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
  }
  // Wait for OS to reap the children — confirms the kill landed.
  const exitWaits = await Promise.all(
    children.map(
      (c) =>
        new Promise((resolve) => {
          if (c.exitCode !== null || c.signalCode !== null) {
            return resolve({
              pid: c.pid,
              exit_code: c.exitCode,
              signal: c.signalCode,
              already_exited: true,
            });
          }
          c.once("exit", (code, signal) => {
            resolve({
              pid: c.pid,
              exit_code: code,
              signal,
              reaped_ms_from_kill: Math.round(performance.now() - tKill),
            });
          });
        })
    )
  );
  report.kill = {
    at: killTimeIso,
    signal: "SIGKILL",
    children: exitWaits,
  };

  // Phase 4: observe.
  await new Promise((r) => setTimeout(r, OBSERVE_AFTER_KILL_MS));

  browser.stop();
  bonjour.destroy();

  // Final report.
  const downEvents = events.filter((e) => e.kind === "down" && e.t_ms_from_kill !== null);
  const stillSeenAlive = Array.from(seen.entries())
    .filter(([, v]) => !v.downSeen)
    .map(([name]) => name);
  const downByName = new Map();
  for (const e of downEvents) {
    if (!downByName.has(e.name)) downByName.set(e.name, e.t_ms_from_kill);
  }
  report.observe = {
    window_ms: OBSERVE_AFTER_KILL_MS,
    down_events_total: downEvents.length,
    distinct_down_names: downByName.size,
    expected_down: PUBLISHER_COUNT,
    all_publishers_got_down: downByName.size === PUBLISHER_COUNT,
    earliest_down_ms_from_kill:
      downEvents.length > 0
        ? Math.min(...downEvents.map((e) => e.t_ms_from_kill))
        : null,
    latest_down_ms_from_kill:
      downEvents.length > 0
        ? Math.max(...downEvents.map((e) => e.t_ms_from_kill))
        : null,
    still_seen_alive_at_end: stillSeenAlive,
    per_publisher_down_ms_from_kill: Object.fromEntries(downByName),
  };

  report.events = events;
  report.finished_at = new Date().toISOString();

  // Verdict — the spike's job is to *characterize* what bonjour-service
  // does, not to assert that any particular outcome is correct. So the
  // exit code reflects "did we get a clean measurement", not "did the
  // library behave the way we hoped". A 0-exit means: we observed all N
  // up, killed them, and recorded what happened. The dashboard-design
  // decision uses the numbers in the report, not the exit code.
  const cleanMeasurement =
    report.settle.all_seen && report.kill.children.every((c) => c.signal === "SIGKILL" || c.already_exited);

  const verdict = [
    `spawn ${report.spawn.spawn_ms} ms`,
    `settle ${report.settle.seen_alive}/${PUBLISHER_COUNT} alive`,
    `kill SIGKILL`,
    `down ${report.observe.distinct_down_names}/${PUBLISHER_COUNT}` +
      (report.observe.distinct_down_names > 0
        ? ` (earliest ${report.observe.earliest_down_ms_from_kill} ms, latest ${report.observe.latest_down_ms_from_kill} ms)`
        : ` (none in ${OBSERVE_AFTER_KILL_MS} ms)`),
    report.observe.all_publishers_got_down
      ? "all eviction observed"
      : `${report.observe.expected_down - report.observe.distinct_down_names} ghosts remain`,
  ];
  console.error(`[spike-mdns-churn] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(cleanMeasurement ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-churn] uncaught:", err);
  process.exit(1);
});
