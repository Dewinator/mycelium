#!/usr/bin/env node
// Wave 3 mDNS spike — cold re-browse on eviction (rejoin mitigation, option III).
//
// Context: spike-mdns-rejoin.mjs (commit 0b3ec74) proved that the
// long-lived `bonjour-service` browser does NOT auto-fire an `up` event
// when an evicted publisher restarts with the same instance name and a
// new ephemeral port — zero rejoin events in 30 s of observation. The
// rejoin spike named three implementation options:
//   (I)   destroy and recreate the browser on every eviction;
//   (II)  run a periodic re-browse cycle independent of the heartbeat;
//   (III) on eviction, instantiate a fresh `Bonjour()` instance and call
//         `find()` once — same cold-discoverer pattern that
//         spike-mdns-two-process.mjs (commit 33068f6) and
//         spike-mdns-fanout.mjs (commit dc9241e) already proved
//         surfaces running publishers within ≤2 s.
// The rejoin spike picked option (III) on paper but did not run it.
// This spike does. If option (III) closes the rejoin gap empirically,
// issue 1's acceptance criterion ("after eviction, re-browse within
// ≤30 s and re-admit on next successful fetch") becomes a direct lift
// from this spike's code path rather than a reimplementation.
//
// What this validates:
//   - that a freshly-instantiated `Bonjour()` browser, started AFTER
//     the original browser has been alive for the full publish→kill→
//     evict cycle, surfaces the rejoined publisher's new ephemeral
//     HTTP port via mDNS;
//   - that cold-browse also surfaces the un-killed survivors (so the
//     re-browse is comprehensive, not just "saw the victim") — the
//     implementation has to use cold-browse output as a full candidate
//     refresh, not as a delta;
//   - that the cold-browse settle latency is bounded (≤2 s on the home-
//     WiFi N=3 case; the fanout spike showed ≤1.1 s for N=10);
//   - that adopting the cold-browsed URL into the heartbeat state lifts
//     the eviction and produces successful heartbeats against the new
//     URL within the same 5 s heartbeat budget as steady-state;
//   - that destroying the cold Bonjour instance does not perturb the
//     long-lived browser still running for the survivors.
//
// What this is NOT:
//   - cross-host. Same single-Mac, three-subprocess loopback model as
//     every other spike in this directory.
//   - signature verification. Mock `NodeAdvertisement` is unsigned; the
//     re-browse question is purely about mDNS event semantics + URL
//     routing.
//   - a measurement of the *full* eviction → cold-rebrowse → re-admit
//     pipeline in production. The spike's cold-rebrowse fires
//     immediately after eviction is detected; production may delay or
//     coalesce. The spike answers "does cold-rebrowse work at all," not
//     "what's the optimal trigger cadence."
//
// Method:
//   1. Spawn N=3 publishers with STABLE node_ids (cold-A/B/C). Production
//      model: node_id = multihash(pubkey), persistent across restarts;
//      mDNS instance name `mycelium-cold-X`, also stable.
//   2. Long-lived bonjour browser learns each publisher's URL+node_id
//      from TXT. Run heartbeat loop (5 s interval, 2 s timeout, 3-fail
//      eviction).
//   3. After SETTLE_HEARTBEATS clean rounds, SIGKILL the victim (cold-A).
//   4. Continue heartbeating until eviction (~15 s).
//   5. Wait REJOIN_DELAY_MS, then respawn the victim with the SAME
//      SPIKE_NODE_ID. New PID → new ephemeral HTTP port → URL changes.
//   6. **Critical step**: instead of waiting for the long-lived browser
//      to fire `up`, instantiate a FRESH `new Bonjour()` instance,
//      `find({ type: "mycelium" })`, observe for COLD_SETTLE_MS, collect
//      every `up` event keyed by instance name, then `browser.stop()` +
//      `bonjour.destroy()`.
//   7. From the cold-browse harvest, find the entry whose
//      `txt.node_id == victim_node_id`. Record:
//      - latency from cold-browse start to first up-event for victim;
//      - the new URL/port;
//      - whether the victim was found at all in the cold-browse window;
//      - whether all survivors were also found (comprehensiveness).
//   8. Adopt the new victim URL into heartbeat state, reset fail_count,
//      lift eviction. Continue heartbeating to verify the rejoined
//      entry is reachable for several more rounds.
//   9. Verify the long-lived browser is still functioning afterward
//      (heartbeats against the original survivor URLs continue clean).
//  10. Report: cold-rebrowse harvest, victim re-admission timestamps,
//      survivor cleanliness throughout.
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

const PUBLISHER_COUNT = Number(process.env.SPIKE_COLD_N) || 3;
const HEARTBEAT_INTERVAL_MS = Number(process.env.SPIKE_COLD_INTERVAL_MS) || 5000;
const HEARTBEAT_TIMEOUT_MS = Number(process.env.SPIKE_COLD_TIMEOUT_MS) || 2000;
const BODY_SELF_CAP_BYTES = 64 * 1024;
const FAIL_THRESHOLD = Number(process.env.SPIKE_COLD_FAIL_THRESHOLD) || 3;
const SETTLE_HEARTBEATS = Number(process.env.SPIKE_COLD_SETTLE) || 2;
// Window for the long-lived browser's initial discovery. Same as the
// fanout spike: 4 s is generous for N=3 on a quiet loopback.
const MDNS_SETTLE_MS = Number(process.env.SPIKE_COLD_MDNS_SETTLE_MS) || 4000;
// Window for the cold-rebrowse harvest after respawn. The fanout spike
// proved N=3 in 625 ms and N=10 in 1088 ms; 2 s is the production budget
// the design doc names. Spike timing should fit comfortably inside.
const COLD_SETTLE_MS = Number(process.env.SPIKE_COLD_REBROWSE_MS) || 2000;
// After eviction is confirmed, wait briefly before respawning so the
// rejoin path is realistic — production rejoins happen seconds after
// the original publisher dies, not microseconds.
const REJOIN_DELAY_MS = Number(process.env.SPIKE_COLD_REJOIN_DELAY_MS) || 1000;
// Window after re-admission: long enough that the rejoined publisher
// gets at least 2 successful heartbeats AND the survivors keep going.
const OBSERVE_AFTER_REJOIN_MS = Number(process.env.SPIKE_COLD_OBSERVE_MS) || 15_000;
const PUBLISHER_LIFETIME_MS =
  MDNS_SETTLE_MS +
  (SETTLE_HEARTBEATS + 4) * HEARTBEAT_INTERVAL_MS +
  REJOIN_DELAY_MS +
  COLD_SETTLE_MS +
  OBSERVE_AFTER_REJOIN_MS +
  10_000;
const SERVICE_TYPE = "mycelium";
const KILL_VICTIM_INDEX = 0;
const STABLE_NODE_IDS = Array.from({ length: PUBLISHER_COUNT }, (_, i) =>
  `cold-${String.fromCharCode(65 + i)}`
);

const report = {
  spike: "wave-3-mdns-cold-rebrowse",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http + node:child_process",
  config: {
    publishers: PUBLISHER_COUNT,
    stable_node_ids: STABLE_NODE_IDS,
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    body_self_cap_bytes: BODY_SELF_CAP_BYTES,
    fail_threshold: FAIL_THRESHOLD,
    settle_heartbeats: SETTLE_HEARTBEATS,
    mdns_settle_ms: MDNS_SETTLE_MS,
    cold_settle_ms: COLD_SETTLE_MS,
    rejoin_delay_ms: REJOIN_DELAY_MS,
    observe_after_rejoin_ms: OBSERVE_AFTER_REJOIN_MS,
    kill_victim_index: KILL_VICTIM_INDEX,
    expected_detection_ms: FAIL_THRESHOLD * HEARTBEAT_INTERVAL_MS,
  },
};

function spawnPublisher(nodeId) {
  return spawn(process.execPath, [PUBLISHER_SPIKE, "--publish"], {
    env: {
      ...process.env,
      SPIKE_PUBLISH_MS: String(PUBLISHER_LIFETIME_MS),
      SPIKE_NODE_ID: nodeId,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function fetchUrl(url, { selfCapBytes = BODY_SELF_CAP_BYTES, timeoutMs = HEARTBEAT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
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

// Cold-rebrowse: fresh Bonjour instance, find for SERVICE_TYPE, collect
// every `up` event during settleMs, then fully stop+destroy. This is the
// exact code shape option (III) prescribes for the implementation.
async function coldRebrowse({ settleMs }) {
  const t0 = performance.now();
  const harvested = new Map(); // instance name → { url, node_id, port, first_seen_ms }
  const events = []; // raw event log for forensic inspection
  const bonjour = new Bonjour();
  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    if (typeof svc.name !== "string") return;
    if (!svc.name.startsWith("mycelium-cold-")) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    const elapsed = Math.round(performance.now() - t0);
    events.push({ name: svc.name, node_id: nodeId, url, port: svc.port, t_ms: elapsed });
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
    raw_events: events,
    settle_total_ms: total,
  };
}

async function main() {
  // Phase 1: spawn N publishers with stable node_ids.
  const tSpawn = performance.now();
  const children = new Map();
  for (const nodeId of STABLE_NODE_IDS) {
    children.set(nodeId, spawnPublisher(nodeId));
  }
  report.spawn = {
    children_pids: Array.from(children.entries()).map(([nodeId, c]) => ({
      node_id: nodeId,
      pid: c.pid ?? null,
    })),
    spawn_ms: Math.round(performance.now() - tSpawn),
  };
  await new Promise((r) => setTimeout(r, 750));

  // Phase 2: long-lived browser learns initial publishers. We KEEP this
  // browser running through the kill+respawn so the spike can prove that
  // (a) the cold rebrowse adds new state without conflict and
  // (b) the long-lived browser keeps functioning for the survivors.
  const longBonjour = new Bonjour();
  const tDiscover = performance.now();
  const candidates = new Map(); // instance name → { url, node_id, port, first_seen_ms }
  const longLivedUpEventsAfterRespawn = []; // forensic: did the long-lived browser ever fire post-respawn?
  let respawnAt = null;

  const longBrowser = longBonjour.find({ type: SERVICE_TYPE });
  longBrowser.on("up", (svc) => {
    if (typeof svc.name !== "string") return;
    if (!svc.name.startsWith("mycelium-cold-")) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    if (!url || !nodeId) return;
    if (respawnAt !== null) {
      longLivedUpEventsAfterRespawn.push({
        name: svc.name,
        node_id: nodeId,
        url,
        port: svc.port,
        t_ms_from_respawn: Math.round(performance.now() - respawnAt),
      });
    }
    if (!candidates.has(svc.name)) {
      candidates.set(svc.name, {
        url,
        node_id: nodeId,
        port: svc.port,
        first_seen_ms: Math.round(performance.now() - tDiscover),
      });
    }
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
    longBrowser.stop();
    longBonjour.destroy();
    for (const c of children.values()) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `only saw ${candidates.size}/${PUBLISHER_COUNT} publishers in mDNS settle`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-cold-rebrowse] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  const victimNodeId = STABLE_NODE_IDS[KILL_VICTIM_INDEX];
  const victimEntry = Array.from(candidates.entries()).find(
    ([, c]) => c.node_id === victimNodeId
  );
  if (!victimEntry) {
    longBrowser.stop();
    longBonjour.destroy();
    for (const c of children.values()) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `victim node_id ${victimNodeId} not found in mDNS candidates`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-cold-rebrowse] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  const victimName = victimEntry[0];
  const initialVictimUrl = victimEntry[1].url;
  const initialVictimPort = victimEntry[1].port;
  report.kill_target = {
    name: victimName,
    node_id: victimNodeId,
    initial_url: initialVictimUrl,
    initial_port: initialVictimPort,
    pid: children.get(victimNodeId).pid,
  };

  // Phase 3: heartbeat eviction loop.
  const state = new Map();
  for (const [name, c] of candidates) {
    state.set(name, {
      url: c.url,
      node_id: c.node_id,
      fail_count: 0,
      evicted_at_hb: null,
      evicted_at_ms_from_kill: null,
      heartbeats: [],
      readmitted_at_hb: null,
      readmitted_at_ms_from_respawn: null,
      successful_heartbeats_post_readmit: 0,
    });
  }

  let hbRound = 0;
  let tKill = null;
  let killTimeIso = null;
  let respawnTimeIso = null;
  let coldRebrowseDone = false;
  let coldRebrowseResult = null;
  const tHeartbeatStart = performance.now();

  while (true) {
    hbRound += 1;
    const tRound = performance.now();

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
        t_ms_from_respawn: respawnAt === null ? null : Math.round(tRound - respawnAt),
        url_used: s.url,
        ok: r.ok,
        status: r.status,
        ms: r.ms,
        bytes: r.bytes,
        timed_out: r.timed_out,
        error: r.error ?? null,
      });
      if (r.ok) {
        s.fail_count = 0;
        if (s.readmitted_at_hb !== null && name === victimName) {
          s.successful_heartbeats_post_readmit += 1;
        }
      } else {
        s.fail_count += 1;
        if (s.fail_count >= FAIL_THRESHOLD && s.evicted_at_hb === null) {
          s.evicted_at_hb = hbRound;
          s.evicted_at_ms_from_kill = tKill === null ? null : Math.round(performance.now() - tKill);
        }
      }
    }

    // Trigger SIGKILL once baseline is stable.
    if (tKill === null) {
      const victimState = state.get(victimName);
      const victimSuccessfulRounds = victimState.heartbeats.filter((h) => h.ok).length;
      if (victimSuccessfulRounds >= SETTLE_HEARTBEATS) {
        const baselineClean = Array.from(state.values()).every((s) => s.fail_count === 0);
        if (!baselineClean) {
          report.aborted = "baseline unstable — a heartbeat failed before kill";
          break;
        }
        tKill = performance.now();
        killTimeIso = new Date().toISOString();
        const victimChild = children.get(victimNodeId);
        if (victimChild.exitCode === null && !victimChild.killed) victimChild.kill("SIGKILL");
        report.kill = {
          at: killTimeIso,
          signal: "SIGKILL",
          at_heartbeat_round: hbRound,
          victim_pid: victimChild.pid,
          victim_node_id: victimNodeId,
        };
      }
    }

    // After eviction is confirmed: respawn, then cold-rebrowse, then
    // adopt the new URL into heartbeat state.
    if (tKill !== null && respawnAt === null) {
      const victimState = state.get(victimName);
      if (victimState.evicted_at_hb !== null) {
        await new Promise((r) => setTimeout(r, REJOIN_DELAY_MS));
        respawnAt = performance.now();
        respawnTimeIso = new Date().toISOString();
        const newChild = spawnPublisher(victimNodeId);
        children.set(victimNodeId, newChild);
        report.respawn = {
          at: respawnTimeIso,
          delay_ms_after_eviction: REJOIN_DELAY_MS,
          new_pid: newChild.pid,
          stable_node_id: victimNodeId,
        };
      }
    }

    // Critical step: trigger cold-rebrowse exactly once, immediately after
    // respawn. This is the option-III code shape.
    if (respawnAt !== null && !coldRebrowseDone) {
      const tColdStart = performance.now();
      coldRebrowseResult = await coldRebrowse({ settleMs: COLD_SETTLE_MS });
      coldRebrowseDone = true;
      const tColdEnd = performance.now();
      report.cold_rebrowse = {
        triggered_at_ms_from_respawn: Math.round(tColdStart - respawnAt),
        settle_window_ms: COLD_SETTLE_MS,
        wall_time_ms: Math.round(tColdEnd - tColdStart),
        harvested_count: coldRebrowseResult.harvested.length,
        harvested: coldRebrowseResult.harvested,
        raw_event_count: coldRebrowseResult.raw_events.length,
        all_publishers_seen:
          coldRebrowseResult.harvested.length === PUBLISHER_COUNT,
      };

      // Find victim in the harvest.
      const victimHarvest = coldRebrowseResult.harvested.find(
        (h) => h.node_id === victimNodeId
      );
      if (!victimHarvest) {
        report.aborted = `cold-rebrowse did NOT surface victim ${victimNodeId} within ${COLD_SETTLE_MS} ms`;
        break;
      }
      const isUrlChanged = victimHarvest.url !== initialVictimUrl;
      report.cold_rebrowse.victim = {
        node_id: victimNodeId,
        old_url: initialVictimUrl,
        new_url: victimHarvest.url,
        url_changed: isUrlChanged,
        old_port: initialVictimPort,
        new_port: victimHarvest.port,
        first_seen_ms_in_cold_browse: victimHarvest.first_seen_ms,
      };

      // Adopt the new URL into heartbeat state — exactly the operation
      // the candidate-set machinery has to perform.
      const victimState = state.get(victimName);
      victimState.url = victimHarvest.url;
      victimState.fail_count = 0;
      victimState.readmitted_at_hb = hbRound;
      victimState.readmitted_at_ms_from_respawn = Math.round(performance.now() - respawnAt);
      victimState.evicted_at_hb = null;
    }

    // Termination: all heartbeat work after cold-rebrowse.
    if (coldRebrowseDone && respawnAt !== null) {
      const sinceRespawn = performance.now() - respawnAt;
      const victimState = state.get(victimName);
      if (
        sinceRespawn >= OBSERVE_AFTER_REJOIN_MS &&
        victimState.successful_heartbeats_post_readmit >= 1
      ) {
        break;
      }
      // Safety: window expired with no successful re-admit heartbeat.
      if (sinceRespawn >= OBSERVE_AFTER_REJOIN_MS + HEARTBEAT_INTERVAL_MS * 2) {
        report.aborted = `victim ${victimName} re-admitted via cold-rebrowse but heartbeat against new URL never succeeded`;
        break;
      }
    }

    const elapsed = performance.now() - tRound;
    const sleep = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, sleep));
  }

  longBrowser.stop();
  longBonjour.destroy();
  for (const c of children.values()) {
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
      currently_evicted: s.evicted_at_hb !== null,
      readmitted_at_heartbeat_round: s.readmitted_at_hb,
      readmitted_at_ms_from_respawn: s.readmitted_at_ms_from_respawn,
      successful_heartbeats_post_readmit: s.successful_heartbeats_post_readmit,
      heartbeats: s.heartbeats,
    };
    totalHeartbeats += s.heartbeats.length;
    totalBytes += s.heartbeats.reduce((a, h) => a + (h.bytes ?? 0), 0);
    totalMs += s.heartbeats.reduce((a, h) => a + (h.ms ?? 0), 0);
  }

  const victim = perPublisher[victimName];
  const survivorNames = Array.from(candidates.keys()).filter((n) => n !== victimName);
  const survivors = survivorNames.map((n) => perPublisher[n]);

  report.heartbeat = {
    rounds_completed: hbRound,
    total_heartbeats: totalHeartbeats,
    total_bytes_on_wire: totalBytes,
    avg_ms_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalMs / totalHeartbeats) : null,
    avg_bytes_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalBytes / totalHeartbeats) : null,
  };
  report.long_lived_browser = {
    up_events_after_respawn_count: longLivedUpEventsAfterRespawn.length,
    up_events_after_respawn: longLivedUpEventsAfterRespawn,
    note:
      "spike-mdns-rejoin (commit 0b3ec74) showed zero up-events on the long-lived browser after respawn. This field documents that result was not a measurement artifact: the long-lived browser is held throughout the cold-rebrowse cycle so any up-event it would fire is recorded here for direct comparison.",
  };
  report.victim_summary = {
    name: victimName,
    node_id: victimNodeId,
    initial_url: initialVictimUrl,
    final_url: victim.url,
    readmitted_via_cold_rebrowse: report.cold_rebrowse?.victim != null,
    cold_rebrowse_url_changed:
      report.cold_rebrowse?.victim?.url_changed === true,
    successful_heartbeats_post_readmit: victim.successful_heartbeats_post_readmit,
    readmitted_at_heartbeat_round: victim.readmitted_at_heartbeat_round,
    readmitted_at_ms_from_respawn: victim.readmitted_at_ms_from_respawn,
  };
  report.survivors = {
    count: survivors.length,
    all_alive_at_end: survivors.every((s) => !s.currently_evicted),
    any_false_positive_eviction: survivors.some((s) => s.currently_evicted),
    max_final_fail_count: survivors.reduce((m, s) => Math.max(m, s.final_fail_count), 0),
    total_failed_heartbeats: survivors.reduce((a, s) => a + s.failed_heartbeats, 0),
  };
  report.per_publisher = perPublisher;
  report.finished_at = new Date().toISOString();

  // Verdict — clean = victim was evicted, cold-rebrowse surfaced the
  // rejoined publisher with a different URL, the candidate-set adopted
  // the new URL, at least one heartbeat against the new URL succeeded,
  // and survivors stayed alive throughout.
  const clean =
    !report.aborted &&
    report.cold_rebrowse?.victim != null &&
    report.cold_rebrowse.victim.url_changed === true &&
    report.cold_rebrowse.all_publishers_seen === true &&
    report.victim_summary.successful_heartbeats_post_readmit >= 1 &&
    report.survivors.all_alive_at_end &&
    !report.survivors.any_false_positive_eviction;

  const verdict = [
    `discover ${report.discover.seen}/${PUBLISHER_COUNT}`,
    `heartbeat ${hbRound} rounds (${totalHeartbeats} probes)`,
    report.cold_rebrowse?.victim
      ? `cold-rebrowse saw victim at ${report.cold_rebrowse.victim.first_seen_ms_in_cold_browse} ms (URL ${report.cold_rebrowse.victim.url_changed ? "changed" : "unchanged"})`
      : "cold-rebrowse did NOT see victim",
    `harvest ${report.cold_rebrowse?.harvested_count ?? 0}/${PUBLISHER_COUNT}`,
    `victim ${report.victim_summary.successful_heartbeats_post_readmit}× post-readmit heartbeat`,
    `long-lived up-events post-respawn: ${longLivedUpEventsAfterRespawn.length}`,
    `survivors ${report.survivors.all_alive_at_end ? "all alive" : "some evicted"}`,
    clean ? "OK" : (report.aborted ?? "FAIL"),
  ];
  console.error(`[spike-mdns-cold-rebrowse] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-cold-rebrowse] uncaught:", err);
  process.exit(1);
});
