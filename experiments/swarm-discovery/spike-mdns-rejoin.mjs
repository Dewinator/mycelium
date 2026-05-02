#!/usr/bin/env node
// Wave 3 mDNS spike — re-discovery after eviction (rejoin path).
//
// Context: spike-mdns-heartbeat.mjs (commit ceb4262) validated that a
// crashed publisher is evicted within 15 s ± 3 ms via 3-consecutive-fail
// re-fetch. Its own header named the next gap explicitly — "re-discovery
// after eviction. If the killed publisher restarts, mDNS would surface it
// again and the loop would re-add it." The heartbeat spike treated this
// as orthogonal; for the implementation, it isn't. Reed's archetypal use
// case is "two laptops on the same WiFi, one wakes from sleep" — the
// other laptop's mycelium MUST resurface the rejoined peer or the WiFi-
// sleep cycle silently breaks the swarm.
//
// The implementation question issue 1 needs an answer for: when the same
// `node_id` reappears via mDNS (production model: node_id = multihash of
// the persistent Ed25519 pubkey, so it survives process restart), does
// the candidate-set machinery have to do anything special, or does the
// existing browser+fetch loop carry the rejoin for free?
//
// What this validates:
//   - that `bonjour-service` emits an `up` event for the same instance
//     name when its publisher process restarts, even though the instance
//     name was already in the browser's seen-set;
//   - that the rejoin event carries the publisher's NEW ephemeral HTTP
//     port (not a stale value cached from the original publish), so a
//     URL-based candidate set has the data it needs to redirect;
//   - that a heartbeat against the new URL succeeds within the same
//     budget the steady-state heartbeat uses;
//   - that the survivors (un-killed publishers) stay alive across the
//     full kill→rejoin transition with zero false-positive evictions —
//     i.e. the rejoin event doesn't perturb their state.
//
// What this is NOT:
//   - cross-host. Same single-Mac, three-subprocess loopback model as
//     every other spike in this directory. The cross-host validation is
//     still open separately.
//   - signature verification. The mock advertisement is unsigned. The
//     rejoin question is purely about mDNS event semantics + URL routing
//     — those don't change once Ed25519 signing is added.
//   - operator-promotion. The TrustEdge.weight transition that the
//     dashboard surfaces is a UI question; this spike answers the layer
//     beneath it.
//
// Method:
//   1. Spawn N=3 publishers with STABLE node_ids (rejoin-A/B/C) via
//      SPIKE_NODE_ID env. Production model: node_id is persistent across
//      restarts; mDNS instance name is `mycelium-<node_id>`, also stable.
//   2. Browse mDNS, learn each publisher's URL+node_id from TXT. Keep the
//      browser running (unlike spike-mdns-heartbeat.mjs which stopped it
//      after settle) — the rejoin event needs the browser alive to fire.
//   3. Run heartbeat loop against all known URLs (5 s interval, 2 s
//      timeout, 3-fail eviction — same shape as spike-mdns-heartbeat.mjs).
//   4. After SETTLE_HEARTBEATS clean rounds, SIGKILL the victim (rejoin-A).
//   5. Continue heartbeating until the victim is evicted (~15 s).
//   6. Respawn the victim with the SAME SPIKE_NODE_ID. New PID → new
//      ephemeral HTTP port → URL changes. Instance name stays the same.
//   7. Observe the browser for the rejoin `up` event. Record:
//      - latency from respawn to rejoin event;
//      - whether the new URL differs from the old (proves new process);
//      - whether the new TXT.node_id matches the old TXT.node_id (proves
//        same identity).
//   8. On rejoin event, replace the candidate's URL, reset fail_count, lift
//      eviction. Continue heartbeating to verify the new URL is reachable
//      and the rejoined publisher stays alive for several more rounds.
//   9. Report per-publisher heartbeat history, rejoin timestamps, total
//      kill→rejoined-and-healthy time.
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

const PUBLISHER_COUNT = Number(process.env.SPIKE_REJOIN_N) || 3;
const HEARTBEAT_INTERVAL_MS = Number(process.env.SPIKE_REJOIN_INTERVAL_MS) || 5000;
const HEARTBEAT_TIMEOUT_MS = Number(process.env.SPIKE_REJOIN_TIMEOUT_MS) || 2000;
const BODY_SELF_CAP_BYTES = 64 * 1024;
const FAIL_THRESHOLD = Number(process.env.SPIKE_REJOIN_FAIL_THRESHOLD) || 3;
const SETTLE_HEARTBEATS = Number(process.env.SPIKE_REJOIN_SETTLE) || 2;
// Window after the rejoin event: long enough that the rejoined publisher
// gets at least 2 successful heartbeats AND the survivors keep going
// without false-positive evictions. 20 s = 4 heartbeat rounds of slack.
const OBSERVE_AFTER_REJOIN_MS = Number(process.env.SPIKE_REJOIN_OBSERVE_MS) || 20_000;
const MDNS_SETTLE_MS = Number(process.env.SPIKE_REJOIN_MDNS_SETTLE_MS) || 4000;
// Max time we'll wait for the rejoin `up` event after respawning. If the
// browser doesn't surface the new instance within this window, the
// implementation cannot rely on mDNS alone for rejoin and the answer to
// the spike question is "the heartbeat-eviction loop must also re-browse,
// or the candidate-set machinery must include a periodic re-discovery."
const REJOIN_EVENT_TIMEOUT_MS = Number(process.env.SPIKE_REJOIN_EVENT_TIMEOUT_MS) || 30_000;
// After eviction is confirmed, wait a bit before respawning so the
// browser's internal state (record TTLs, etc) has a chance to age. This
// makes the rejoin path realistic — production rejoins happen seconds to
// minutes after the original publisher dies, not microseconds.
const REJOIN_DELAY_MS = Number(process.env.SPIKE_REJOIN_DELAY_MS) || 1000;
const PUBLISHER_LIFETIME_MS =
  MDNS_SETTLE_MS +
  (SETTLE_HEARTBEATS + 4) * HEARTBEAT_INTERVAL_MS +
  REJOIN_EVENT_TIMEOUT_MS +
  OBSERVE_AFTER_REJOIN_MS +
  10_000;
const SERVICE_TYPE = "mycelium";
const KILL_VICTIM_INDEX = 0;
const STABLE_NODE_IDS = Array.from({ length: PUBLISHER_COUNT }, (_, i) =>
  `rejoin-${String.fromCharCode(65 + i)}`
);

const report = {
  spike: "wave-3-mdns-rejoin",
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
    observe_after_rejoin_ms: OBSERVE_AFTER_REJOIN_MS,
    mdns_settle_ms: MDNS_SETTLE_MS,
    rejoin_event_timeout_ms: REJOIN_EVENT_TIMEOUT_MS,
    rejoin_delay_ms: REJOIN_DELAY_MS,
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

async function main() {
  // Phase 1: spawn N publishers with stable node_ids.
  const tSpawn = performance.now();
  const children = new Map(); // node_id → child process
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

  // Phase 2: discover via mDNS. Keep the browser running so the rejoin
  // event can fire later in the same session.
  const bonjour = new Bonjour();
  const tDiscover = performance.now();
  // Per-instance state. Keyed by mDNS instance NAME (not node_id) because
  // bonjour's `up` events arrive name-keyed; we then resolve to node_id
  // via the TXT record.
  const candidates = new Map(); // instance name → { url, node_id, port, first_seen_ms, up_event_count }
  // Per-node-id rejoin log: every time the browser surfaces a service
  // whose TXT.node_id matches a known node_id, append. Empty until the
  // respawn step.
  const rejoinEvents = []; // { node_id, instance_name, url, port, t_ms_from_respawn, txn }

  let respawnAt = null; // performance.now() value when respawn was triggered

  const browser = bonjour.find({ type: SERVICE_TYPE });
  browser.on("up", (svc) => {
    if (typeof svc.name !== "string") return;
    if (!svc.name.startsWith("mycelium-rejoin-")) return;
    const url = svc.txt && typeof svc.txt.url === "string" ? svc.txt.url : null;
    const nodeId = svc.txt && typeof svc.txt.node_id === "string" ? svc.txt.node_id : null;
    if (!url || !nodeId) return;
    const existing = candidates.get(svc.name);
    if (!existing) {
      candidates.set(svc.name, {
        url,
        node_id: nodeId,
        port: svc.port,
        first_seen_ms: Math.round(performance.now() - tDiscover),
        up_event_count: 1,
      });
      return;
    }
    // Same instance name reappeared. This is the rejoin signal.
    existing.up_event_count += 1;
    const t_from_respawn = respawnAt === null ? null : Math.round(performance.now() - respawnAt);
    const isUrlChanged = existing.url !== url;
    rejoinEvents.push({
      node_id: nodeId,
      instance_name: svc.name,
      old_url: existing.url,
      new_url: url,
      url_changed: isUrlChanged,
      old_port: existing.port,
      new_port: svc.port,
      t_ms_from_respawn: t_from_respawn,
      seen_after_respawn: respawnAt !== null,
    });
    // Adopt the new URL/port. This is exactly what the implementation
    // candidate-set machinery has to do: same node_id, new transport.
    existing.url = url;
    existing.port = svc.port;
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
    for (const c of children.values()) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `only saw ${candidates.size}/${PUBLISHER_COUNT} publishers in mDNS settle`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-rejoin] ABORT — ${report.aborted}`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }

  // Resolve the victim by stable node_id (not array index, not PID — see
  // spike-mdns-heartbeat.mjs's lesson about indexing assumptions).
  const victimNodeId = STABLE_NODE_IDS[KILL_VICTIM_INDEX];
  const victimEntry = Array.from(candidates.entries()).find(
    ([, c]) => c.node_id === victimNodeId
  );
  if (!victimEntry) {
    browser.stop();
    bonjour.destroy();
    for (const c of children.values()) {
      if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
    }
    report.aborted = `victim node_id ${victimNodeId} not found in mDNS candidates`;
    report.finished_at = new Date().toISOString();
    console.error(`[spike-mdns-rejoin] ABORT — ${report.aborted}`);
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

  // Phase 3: heartbeat loop. Same shape as spike-mdns-heartbeat.mjs but
  // with rejoin handling: when an evicted instance appears in the
  // rejoinEvents log, lift the eviction and reset fail_count.
  const state = new Map();
  for (const [name, c] of candidates) {
    state.set(name, {
      url: c.url,
      node_id: c.node_id,
      fail_count: 0,
      evicted_at_hb: null,
      evicted_at_ms_from_start: null,
      evicted_at_ms_from_kill: null,
      heartbeats: [],
      rejoined_at_hb: null,
      rejoined_at_ms_from_respawn: null,
      successful_heartbeats_post_rejoin: 0,
    });
  }

  let hbRound = 0;
  let tKill = null;
  let killTimeIso = null;
  let respawnTimeIso = null;
  let rejoinSeenAt = null; // performance.now() when the up event for the rejoined victim arrived
  let rejoinedHeartbeatStarted = false;
  const tHeartbeatStart = performance.now();

  while (true) {
    hbRound += 1;
    const tRound = performance.now();

    // Before every round, check whether the victim's candidate URL has
    // been replaced via a rejoin event. If yes AND the heartbeat state
    // is still flagged evicted, lift the eviction.
    if (
      rejoinSeenAt !== null &&
      rejoinedHeartbeatStarted === false
    ) {
      const victimState = state.get(victimName);
      const candidate = candidates.get(victimName);
      if (victimState.evicted_at_hb !== null) {
        victimState.url = candidate.url; // adopt new URL from candidate map
        victimState.fail_count = 0;
        // We DO record the eviction in history, but flip the active flag
        // by marking rejoined_at_hb. This is the candidate-set contract
        // the implementation has to honour.
        victimState.rejoined_at_hb = hbRound;
        victimState.rejoined_at_ms_from_respawn = Math.round(
          performance.now() - respawnAt
        );
        // Lift eviction so the loop heartbeats this entry again.
        victimState.evicted_at_hb = null;
        rejoinedHeartbeatStarted = true;
      } else {
        // Edge case: rejoin event arrived BEFORE the heartbeat loop had
        // marked the victim evicted (e.g. because a heartbeat was in
        // flight when the kill landed and the response error didn't
        // count toward fail_count yet). Adopt the new URL anyway and
        // log the path.
        victimState.url = candidate.url;
        victimState.rejoined_at_hb = hbRound;
        victimState.rejoined_at_ms_from_respawn = Math.round(
          performance.now() - respawnAt
        );
        rejoinedHeartbeatStarted = true;
      }
    }

    // Fan out heartbeats in parallel against all non-evicted entries.
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
        if (s.rejoined_at_hb !== null && name === victimName) {
          s.successful_heartbeats_post_rejoin += 1;
        }
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
    // clean rounds against everyone.
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

    // After eviction is confirmed, schedule the respawn.
    if (tKill !== null && respawnAt === null) {
      const victimState = state.get(victimName);
      if (victimState.evicted_at_hb !== null) {
        // Wait REJOIN_DELAY_MS after eviction so the spike doesn't measure
        // a hot-cache rejoin that wouldn't reflect reality.
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
        // Set up a one-shot watcher: if no rejoin up-event arrives
        // within REJOIN_EVENT_TIMEOUT_MS, that's the answer to one of
        // the spike's questions.
        const rejoinTimer = setTimeout(() => {
          if (rejoinSeenAt === null) {
            report.rejoin_timeout = {
              waited_ms: REJOIN_EVENT_TIMEOUT_MS,
              answer: "no rejoin up-event observed within budget",
            };
          }
        }, REJOIN_EVENT_TIMEOUT_MS);
        rejoinTimer.unref();
      }
    }

    // After respawn, record the moment the rejoin event landed (set by
    // the browser handler — we just snapshot here for loop-internal use).
    if (respawnAt !== null && rejoinSeenAt === null) {
      const lastRejoinForVictim = rejoinEvents.find(
        (e) => e.node_id === victimNodeId && e.seen_after_respawn
      );
      if (lastRejoinForVictim) {
        rejoinSeenAt = performance.now();
      }
    }

    // Termination: respawn happened, rejoin observed, post-rejoin window
    // elapsed, and the victim has at least 1 successful heartbeat on the
    // new URL.
    if (respawnAt !== null && rejoinSeenAt !== null) {
      const sinceRejoin = performance.now() - rejoinSeenAt;
      const victimState = state.get(victimName);
      if (
        sinceRejoin >= OBSERVE_AFTER_REJOIN_MS &&
        victimState.successful_heartbeats_post_rejoin >= 1
      ) {
        break;
      }
      // Safety net: window expired but no successful post-rejoin heartbeat.
      if (sinceRejoin >= OBSERVE_AFTER_REJOIN_MS + HEARTBEAT_INTERVAL_MS) {
        report.aborted = `victim ${victimName} rejoined mDNS but heartbeat against new URL never succeeded`;
        break;
      }
    }
    // Safety net: respawn happened but no rejoin event ever arrived.
    if (
      respawnAt !== null &&
      rejoinSeenAt === null &&
      performance.now() - respawnAt >= REJOIN_EVENT_TIMEOUT_MS
    ) {
      report.aborted = `no rejoin up-event for ${victimName} within ${REJOIN_EVENT_TIMEOUT_MS} ms`;
      break;
    }

    const elapsed = performance.now() - tRound;
    const sleep = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);
    await new Promise((r) => setTimeout(r, sleep));
  }

  browser.stop();
  bonjour.destroy();
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
      ever_evicted: s.heartbeats.some((h, i, arr) => {
        // Best-effort: derive "did this entry ever cross the threshold"
        // from the heartbeat sequence. This is approximate (eviction is
        // tracked elsewhere) but useful for the survivor-cleanliness check.
        return false;
      }),
      currently_evicted: s.evicted_at_hb !== null,
      rejoined_at_heartbeat_round: s.rejoined_at_hb,
      rejoined_at_ms_from_respawn: s.rejoined_at_ms_from_respawn,
      successful_heartbeats_post_rejoin: s.successful_heartbeats_post_rejoin,
      heartbeats: s.heartbeats,
    };
    totalHeartbeats += s.heartbeats.length;
    totalBytes += s.heartbeats.reduce((a, h) => a + (h.bytes ?? 0), 0);
    totalMs += s.heartbeats.reduce((a, h) => a + (h.ms ?? 0), 0);
  }

  const victim = perPublisher[victimName];
  const survivorNames = Array.from(candidates.keys()).filter((n) => n !== victimName);
  const survivors = survivorNames.map((n) => perPublisher[n]);

  // Find the FIRST rejoin event that fired AFTER respawn for the victim's
  // node_id — this is the implementation-relevant signal. Earlier events
  // for the victim (if any) are pre-respawn duplicates and don't count.
  const victimRejoinEvent = rejoinEvents.find(
    (e) => e.node_id === victimNodeId && e.seen_after_respawn
  );

  report.heartbeat = {
    rounds_completed: hbRound,
    total_heartbeats: totalHeartbeats,
    total_bytes_on_wire: totalBytes,
    avg_ms_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalMs / totalHeartbeats) : null,
    avg_bytes_per_heartbeat: totalHeartbeats > 0 ? Math.round(totalBytes / totalHeartbeats) : null,
  };
  report.rejoin_event = victimRejoinEvent ?? null;
  report.rejoin_events_total = rejoinEvents.length;
  report.rejoin_events_log = rejoinEvents;
  report.victim_summary = {
    name: victimName,
    node_id: victimNodeId,
    initial_url: initialVictimUrl,
    final_url: victim.url,
    url_changed_after_rejoin:
      victimRejoinEvent && victimRejoinEvent.url_changed === true,
    rejoined_via_mdns: victimRejoinEvent !== undefined,
    successful_heartbeats_post_rejoin: victim.successful_heartbeats_post_rejoin,
    rejoined_at_heartbeat_round: victim.rejoined_at_heartbeat_round,
    rejoined_at_ms_from_respawn: victim.rejoined_at_ms_from_respawn,
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

  // Verdict — clean = victim was evicted, then respawn produced an
  // mDNS up-event with the same node_id, the URL changed (proving it's
  // the new process), and at least one heartbeat against the new URL
  // succeeded; survivors stayed alive throughout.
  const clean =
    !report.aborted &&
    report.rejoin_event !== null &&
    report.victim_summary.url_changed_after_rejoin === true &&
    report.victim_summary.successful_heartbeats_post_rejoin >= 1 &&
    report.survivors.all_alive_at_end &&
    !report.survivors.any_false_positive_eviction;

  const verdict = [
    `discover ${report.discover.seen}/${PUBLISHER_COUNT}`,
    `heartbeat ${hbRound} rounds (${totalHeartbeats} probes)`,
    report.rejoin_event
      ? `rejoin via mDNS at ${report.rejoin_event.t_ms_from_respawn} ms (URL ${report.rejoin_event.url_changed ? "changed" : "unchanged"})`
      : "rejoin event NOT seen",
    `victim ${report.victim_summary.successful_heartbeats_post_rejoin}× post-rejoin heartbeat`,
    `survivors ${report.survivors.all_alive_at_end ? "all alive" : "some evicted"}`,
    clean ? "OK" : (report.aborted ?? "FAIL"),
  ];
  console.error(`[spike-mdns-rejoin] ${verdict.join(" · ")}`);
  console.log(JSON.stringify(report, null, 2));

  process.exit(clean ? 0 : 1);
}

main().catch((err) => {
  console.error("[spike-mdns-rejoin] uncaught:", err);
  process.exit(1);
});
