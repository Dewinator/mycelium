#!/usr/bin/env node
// Wave 3 mDNS spike — heartbeat-based liveness eviction (option (a)).
//
// Context: spike-mdns-churn.mjs (commit f165b27) proved that
// `bonjour-service` emits zero `down` events when publishers exit via
// SIGKILL — the realistic crash case. The design doc names two options
// for the implementation:
//   (a) periodic re-fetch of /.well-known/mycelium-node per known
//       candidate URL, with N consecutive failures evicting the entry;
//   (b) track the per-record TTL bonjour-service exposes and evict on
//       TTL expiry.
// The doc picks (a) as the safer choice — transport-symmetric with the
// bootstrap case (which has no mDNS layer at all), and reuses the
// fetchUrl path the implementation has to ship anyway. But "safer in
// theory" is not the same as "produces the right numbers in practice."
// This spike runs (a) end-to-end and answers two questions the
// implementation issue (#1 in the design doc's "Concrete next steps")
// needs concrete numbers for:
//   - what is the actual detection latency for a crashed peer with
//     interval=5 s, threshold=3 fails? (Doc claims ~15 s; verify.)
//   - does the heartbeat loop produce any false-positive evictions for
//     surviving peers under steady-state load? (If yes, the threshold
//     needs to be higher and the budget shifts.)
//
// What this validates:
//   - that periodic re-fetch with a fail-counter cleanly distinguishes
//     a SIGKILLed publisher from one still serving traffic;
//   - that the eviction lands within (FAIL_THRESHOLD × HEARTBEAT_INTERVAL_MS)
//     plus one timeout window — i.e. the budget the implementation can
//     promise the dashboard;
//   - that the survivor heartbeats stay successful (zero false
//     evictions) across the full observation window;
//   - the bytes-on-wire and time-on-wire cost per heartbeat, so the
//     implementation has a defensible answer for "what does this layer
//     cost a quiet peer?"
//
// What this is NOT:
//   - re-discovery after eviction. If the killed publisher restarts,
//     mDNS would surface it again and the loop would re-add it — that's
//     a correctness property of the candidate-set machinery, but it's
//     orthogonal to the eviction question this spike answers.
//   - cross-host. Single Mac, three subprocesses on loopback — same
//     scope as every other spike in this directory until the open
//     "cross-host validation" item lands.
//   - signature verification. The mock advertisement is unsigned; the
//     fail counter only cares about transport-level success/failure.
//
// Method:
//   1. Spawn N=3 publishers (spike-mdns-fetch.mjs --publish), wait for
//      mDNS settle.
//   2. Browse, learn each publisher's URL+node_id from TXT.
//   3. Start heartbeat loop: every HEARTBEAT_INTERVAL_MS, re-fetch each
//      known URL with the same fetchUrl (timeout + body cap) the
//      implementation will lift.
//   4. Per URL: success → fail_count = 0; failure → fail_count += 1.
//      When fail_count >= FAIL_THRESHOLD, mark the URL evicted with a
//      timestamp.
//   5. After SETTLE_HEARTBEATS heartbeats have run successfully against
//      all publishers, SIGKILL one specific publisher (index 0).
//   6. Continue heartbeating for OBSERVE_AFTER_KILL_MS — long enough
//      that (a) the killed publisher accumulates >= FAIL_THRESHOLD
//      consecutive failures and gets evicted, and (b) the survivors
//      have a chance to false-positive-evict if the loop is buggy.
//   7. Report per-URL heartbeat history, eviction timestamp, total
//      measurement time, network cost.
//
// Output: JSON report on stdout, one-line verdict on stderr.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLISHER_SPIKE = resolvePath(__dirname, "spike-mdns-fetch.mjs");

const PUBLISHER_COUNT = Number(process.env.SPIKE_HB_N) || 3;
// Heartbeat interval: 5 s is the doc's implicit budget — long enough to be
// cheap (one re-fetch per peer per 5 s is negligible CPU/network), short
// enough that 3 consecutive failures = 15 s detection, which matches a
// "peer offline within ~30 s" UX promise comfortably.
const HEARTBEAT_INTERVAL_MS = Number(process.env.SPIKE_HB_INTERVAL_MS) || 5000;
// Per-heartbeat fetch timeout. Reuses the design from spike-mdns-fetch.mjs
// (FETCH_TIMEOUT_MS = 2 s). A heartbeat that doesn't return in 2 s is a
// failure — even if the peer is alive, that latency would itself break the
// "fresh discovery within 2 s" budget the design doc names elsewhere.
const HEARTBEAT_TIMEOUT_MS = Number(process.env.SPIKE_HB_TIMEOUT_MS) || 2000;
// Same body cap as spike-mdns-fetch.mjs's fetchUrl. NodeAdvertisement
// bodies are <1 KiB; 64 KiB is a generous DoS ceiling.
const BODY_SELF_CAP_BYTES = 64 * 1024;
// Consecutive-failure threshold. The doc names "N consecutive failures"
// without picking N; this spike picks 3 because (a) one failure can be a
// transient network blip even on loopback (kernel scheduling, ENFILE), so
// 1 is too jumpy; (b) 5 would push detection to 25 s which is past the
// "peer offline within ~30 s" budget once you add timeout slack; (c) 3
// hits the doc's "≤30 s detection" sweet spot at the 5 s interval.
const FAIL_THRESHOLD = Number(process.env.SPIKE_HB_FAIL_THRESHOLD) || 3;
// Wait this many successful heartbeats against ALL N publishers before
// SIGKILLing — proves the steady-state baseline is clean before perturbing.
const SETTLE_HEARTBEATS = Number(process.env.SPIKE_HB_SETTLE) || 2;
// Window after SIGKILL: long enough that the killed publisher accumulates
// >= FAIL_THRESHOLD failures (3 × 5 s = 15 s) plus slack for the eviction
// to land plus a few more heartbeats to confirm the survivors stay alive.
// 25 s gives the killed publisher 5 chances to fail and the survivors 5
// chances to false-positive-evict.
const OBSERVE_AFTER_KILL_MS = Number(process.env.SPIKE_HB_OBSERVE_MS) || 25_000;
// Settle window for mDNS discovery before the heartbeat loop starts.
// fanout spike measured max first-seen at ~625 ms for N=3; 4 s leaves
// generous slack so "didn't see all N" means a real failure.
const MDNS_SETTLE_MS = Number(process.env.SPIKE_HB_MDNS_SETTLE_MS) || 4000;
// Children outlive the entire test so they don't disappear on their own
// before we either SIGKILL them or finish observing.
const PUBLISHER_LIFETIME_MS =
  MDNS_SETTLE_MS + (SETTLE_HEARTBEATS + 2) * HEARTBEAT_INTERVAL_MS + OBSERVE_AFTER_KILL_MS + 5000;
const SERVICE_TYPE = "mycelium";
const KILL_VICTIM_INDEX = 0; // which publisher gets SIGKILLed

const report = {
  spike: "wave-3-mdns-heartbeat",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http + node:child_process",
  config: {
    publishers: PUBLISHER_COUNT,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    body_self_cap_bytes: BODY_SELF_CAP_BYTES,
    fail_threshold: FAIL_THRESHOLD,
    settle_heartbeats: SETTLE_HEARTBEATS,
    observe_after_kill_ms: OBSERVE_AFTER_KILL_MS,
    mdns_settle_ms: MDNS_SETTLE_MS,
    kill_victim_index: KILL_VICTIM_INDEX,
    expected_detection_ms: FAIL_THRESHOLD * HEARTBEAT_INTERVAL_MS,
  },
};

function spawnPublisher() {
  return spawn(process.execPath, [PUBLISHER_SPIKE, "--publish"], {
    env: { ...process.env, SPIKE_PUBLISH_MS: String(PUBLISHER_LIFETIME_MS) },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

// fetchUrl — same shape as spike-mdns-fetch.mjs's fetchUrl. The
// implementation is meant to lift this verbatim, so the spike validates
// the exact code shape, not a toy variant.
function fetchUrl(url, { selfCapBytes = BODY_SELF_CAP_BYTES, timeoutMs = HEARTBEAT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const chunks = [];
    let total = 0;
    let capped = false;
    let timedOut = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
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
        settle({
          ok: res.statusCode === 200 && !capped,
          status: res.statusCode ?? 0,
          ms,
          bytes: total,
          capped,
          timed_out: false,
        });
      });
    });
    req.on("error", (err) => {
      const ms = Math.round(performance.now() - t0);
      settle({
        ok: false,
        status: 0,
        ms,
        bytes: total,
        capped,
        timed_out: timedOut,
        error: String(err && err.message ? err.message : err),
      });
    });
    req.setTimeout(timeoutMs, () => {
      timedOut = true;
      req.destroy(new Error(`heartbeat timeout after ${timeoutMs} ms`));
    });
    req.end();
  });
}

async function main() {
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
  // Brief pause for HTTP servers + bonjour.publish() to complete.
  await new Promise((r) => setTimeout(r, 750));

  // Phase 2: discover via mDNS, learn URL+node_id per publisher.
  const bonjour = new Bonjour();
  const tDiscover = performance.now();
  const candidates = new Map(); // instance name → { url, node_id, port, first_seen_ms }
  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    if (typeof svc.name !== "string") return;
    if (!svc.name.startsWith("mycelium-spike-")) return;
    if (candidates.has(svc.name)) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    if (!url || !nodeId) return;
    candidates.set(svc.name, {
      url,
      node_id: nodeId,
      port: svc.port,
      first_seen_ms: Math.round(performance.now() - tDiscover),
    });
  });

  await new Promise((r) => setTimeout(r, MDNS_SETTLE_MS));

  report.discover = {
    settle_window_ms: MDNS_SETTLE_MS,
    expected: PUBLISHER_COUNT,
    seen: candidates.size,
    all_seen: candidates.size === PUBLISHER_COUNT,
    instances: Array.from(candidates.entries()).map(([name, c]) => ({
      name,
      node_id: c.node_id,
      port: c.port,
      first_seen_ms: c.first_seen_ms,
    })),
  };

  if (!report.discover.all_seen) {
    browser.stop();
    bonjour.destroy();
    for (const c of children) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `only saw ${candidates.size}/${PUBLISHER_COUNT} publishers in mDNS settle`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-heartbeat] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Stop the browser — the heartbeat loop is the source of truth from
  // here on. Leaving it running would muddy the spike's "is the loop
  // alone enough to detect crashes" question.
  browser.stop();

  // Phase 3: heartbeat loop.
  // State per candidate: fail_count (consecutive), evicted_at_hb (which
  // heartbeat round triggered eviction, null if alive), heartbeats[] (per-
  // round result for forensics).
  const state = new Map();
  for (const [name, c] of candidates) {
    state.set(name, {
      url: c.url,
      node_id: c.node_id,
      fail_count: 0,
      evicted_at_hb: null,
      evicted_at_ms_from_start: null,
      heartbeats: [],
    });
  }

  // Pick the kill victim by matching child PID to candidate node_id, not by
  // candidate-map iteration order. mDNS `up`-event order is independent of
  // spawn order — an earlier-spawned publisher can show up later than a
  // later-spawned one (the first run of this spike SIGKILLed the wrong
  // child precisely because of this assumption). FAKE_NODE_ID in
  // spike-mdns-fetch.mjs is `spike-<pid>`, so the candidate whose node_id
  // matches `spike-<children[KILL_VICTIM_INDEX].pid>` is the one whose
  // process is about to die.
  const victimChild = children[KILL_VICTIM_INDEX];
  const victimNodeId = `spike-${victimChild.pid}`;
  const victimEntry = Array.from(candidates.entries()).find(
    ([, c]) => c.node_id === victimNodeId
  );
  if (!victimEntry) {
    bonjour.destroy();
    for (const c of children) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `victim child PID ${victimChild.pid} (node_id ${victimNodeId}) not found in mDNS candidates`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-heartbeat] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const victimName = victimEntry[0];
  // Stable ordering: victim first, survivors after (used for survivor list).
  const orderedNames = [victimName, ...Array.from(candidates.keys()).filter((n) => n !== victimName)];
  report.kill_target = {
    name: victimName,
    node_id: victimEntry[1].node_id,
    pid: victimChild.pid,
  };

  let hbRound = 0;
  let tKill = null;
  let killTimeIso = null;
  const tHeartbeatStart = performance.now();

  // Run heartbeats until: either we've crossed the SIGKILL boundary, the
  // killed publisher has been evicted, AND we've observed the survivors
  // through the post-kill window. The loop is round-driven (not wall-clock-
  // driven) so the "ran for OBSERVE_AFTER_KILL_MS" condition is computed
  // each round.
  const survivorNames = orderedNames.filter((n) => n !== victimName);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    hbRound += 1;
    const tRound = performance.now();
    // Fan out heartbeats in parallel — same as the fanout spike's fetch
    // strategy, so this loop reflects what the implementation actually
    // does (not an artificially serialised version).
    const results = await Promise.all(
      Array.from(state.entries())
        .filter(([, s]) => s.evicted_at_hb === null)
        .map(async ([name, s]) => {
          const r = await fetchUrl(s.url);
          return { name, r };
        })
    );
    for (const { name, r } of results) {
      const s = state.get(name);
      s.heartbeats.push({
        round: hbRound,
        t_ms_from_start: Math.round(tRound - tHeartbeatStart),
        t_ms_from_kill: tKill === null ? null : Math.round(tRound - tKill),
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        bytes: r.bytes,
        timed_out: r.timed_out,
        error: r.error ?? null,
      });
      if (r.ok) {
        s.fail_count = 0;
      } else {
        s.fail_count += 1;
        if (s.fail_count >= FAIL_THRESHOLD && s.evicted_at_hb === null) {
          s.evicted_at_hb = hbRound;
          s.evicted_at_ms_from_start = Math.round(performance.now() - tHeartbeatStart);
          s.evicted_at_ms_from_kill = tKill === null ? null : Math.round(performance.now() - tKill);
        }
      }
    }

    // Decide whether to SIGKILL the victim now: after SETTLE_HEARTBEATS
    // rounds in which the victim was still alive AND succeeded.
    if (tKill === null) {
      const victimState = state.get(victimName);
      const victimSuccessfulRounds = victimState.heartbeats.filter((h) => h.ok).length;
      if (victimSuccessfulRounds >= SETTLE_HEARTBEATS) {
        // Settle achieved. Verify all publishers are clean (zero failures
        // anywhere). If even one survivor has a fail_count > 0 here, the
        // baseline is unstable and the spike result is meaningless.
        const baselineClean = Array.from(state.values()).every((s) => s.fail_count === 0);
        if (!baselineClean) {
          report.aborted = "baseline unstable — at least one publisher had a heartbeat fail before kill";
          break;
        }
        tKill = performance.now();
        killTimeIso = new Date().toISOString();
        if (victimChild.exitCode === null && !victimChild.killed) victimChild.kill("SIGKILL");
        report.kill = {
          at: killTimeIso,
          signal: "SIGKILL",
          at_heartbeat_round: hbRound,
          victim_pid: victimChild.pid,
        };
      }
    }

    // Termination: post-kill observation done — killed publisher evicted
    // (or threshold reached) AND we've waited the full observe window so
    // any false-positive evictions on survivors had a chance to fire.
    if (tKill !== null) {
      const sinceKill = performance.now() - tKill;
      const victimEvicted = state.get(victimName).evicted_at_hb !== null;
      if (sinceKill >= OBSERVE_AFTER_KILL_MS && victimEvicted) break;
      // Safety net: if the observe window ran out and the victim is STILL
      // not evicted, that's a real failure — record it and stop.
      if (sinceKill >= OBSERVE_AFTER_KILL_MS + HEARTBEAT_INTERVAL_MS) {
        report.aborted = `victim ${victimName} not evicted after observe window ${OBSERVE_AFTER_KILL_MS} ms`;
        break;
      }
    }

    // Pace the next round to interval boundaries (not wall-clock from
    // round-start), so a slow heartbeat doesn't compound into drift.
    const elapsed = performance.now() - tRound;
    const sleep = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, sleep));
  }

  bonjour.destroy();
  for (const c of children) {
    if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
  }

  // Build the final report.
  const perPublisher = {};
  let totalHeartbeats = 0;
  let totalBytes = 0;
  let totalMs = 0;
  for (const [name, s] of state) {
    perPublisher[name] = {
      node_id: s.node_id,
      url: s.url,
      total_heartbeats: s.heartbeats.length,
      successful_heartbeats: s.heartbeats.filter((h) => h.ok).length,
      failed_heartbeats: s.heartbeats.filter((h) => !h.ok).length,
      final_fail_count: s.fail_count,
      evicted: s.evicted_at_hb !== null,
      evicted_at_heartbeat_round: s.evicted_at_hb,
      evicted_at_ms_from_start: s.evicted_at_ms_from_start,
      evicted_at_ms_from_kill: s.evicted_at_ms_from_kill ?? null,
      heartbeats: s.heartbeats,
    };
    totalHeartbeats += s.heartbeats.length;
    totalBytes += s.heartbeats.reduce((a, h) => a + (h.bytes ?? 0), 0);
    totalMs += s.heartbeats.reduce((a, h) => a + (h.ms ?? 0), 0);
  }

  const victim = perPublisher[victimName];
  const survivors = survivorNames.map((n) => perPublisher[n]);

  report.heartbeat = {
    rounds_completed: hbRound,
    total_heartbeats: totalHeartbeats,
    total_bytes_on_wire: totalBytes,
    avg_ms_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalMs / totalHeartbeats) : null,
    avg_bytes_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalBytes / totalHeartbeats) : null,
  };
  report.victim = {
    name: victimName,
    evicted: victim.evicted,
    evicted_at_ms_from_kill: victim.evicted_at_ms_from_kill,
    expected_detection_ms: report.config.expected_detection_ms,
    detection_within_budget:
      victim.evicted && victim.evicted_at_ms_from_kill !== null
        ? victim.evicted_at_ms_from_kill <=
          report.config.expected_detection_ms + HEARTBEAT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS
        : false,
  };
  report.survivors = {
    count: survivors.length,
    all_alive_at_end: survivors.every((s) => !s.evicted),
    any_false_positive_eviction: survivors.some((s) => s.evicted),
    max_final_fail_count: survivors.reduce((m, s) => Math.max(m, s.final_fail_count), 0),
    total_failed_heartbeats: survivors.reduce((a, s) => a + s.failed_heartbeats, 0),
  };
  report.per_publisher = perPublisher;
  report.finished_at = new Date().toISOString();

  // Verdict — clean run = victim evicted within (FAIL_THRESHOLD ×
  // HEARTBEAT_INTERVAL_MS + slack), zero false-positive evictions on
  // survivors. Exit 0 only if both hold AND the heartbeat measurement
  // produced data (no abort).
  const clean =
    !report.aborted &&
    report.victim.evicted &&
    report.victim.detection_within_budget &&
    report.survivors.all_alive_at_end &&
    !report.survivors.any_false_positive_eviction;

  const verdict = [
    `discover ${report.discover.seen}/${PUBLISHER_COUNT}`,
    `heartbeat ${hbRound} rounds (${totalHeartbeats} probes, avg ${report.heartbeat.avg_ms_per_heartbeat} ms)`,
    `victim ${report.victim.evicted ? `evicted at ${report.victim.evicted_at_ms_from_kill} ms` : "NOT evicted"}`,
    `survivors ${report.survivors.all_alive_at_end ? "all alive" : `${survivors.filter((s) => s.evicted).length} false-positive evictions`}`,
    clean ? "OK" : (report.aborted ?? "FAIL"),
  ];
  console.error(`[spike-mdns-heartbeat] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-heartbeat] uncaught:", err);
  process.exit(1);
});
