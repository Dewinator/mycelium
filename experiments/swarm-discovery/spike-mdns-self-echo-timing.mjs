#!/usr/bin/env node
// Wave 3 mDNS spike — self-echo latency distribution under healthy conditions.
//
// docs/swarm-discovery-spike.md (§"Failure modes on real LANs", line ~526)
// names the mDNS-blocked-network detection heuristic as:
//
//   "30 s after starting the responder, if the browser has not seen its own
//    service echoed back from at least one router, log a one-line 'mDNS
//    appears blocked on this network — bootstrap-list still available'
//    notice in the dashboard."
//
// The 30 s number is unsourced. The self-filter spike (commit 71bd74e,
// report-mdns-self-filter.json) showed a single self-echo at first_seen_ms=5
// — but N=1 is not a distribution. Implementation issue 1 needs a defensible
// threshold backed by p95/max over many trials, not a magic number, because
// picking too tight false-positives the "mDNS blocked" warning on a healthy
// LAN with a slow router, and picking too loose makes the dashboard show
// "mDNS working" for 30 s after the user notices nothing happens.
//
// Method:
//   - K=10 publish-and-self-browse trials (configurable via SPIKE_K), each in
//     a fresh Bonjour() instance to defeat any in-process caching.
//   - For each trial: start the browser BEFORE the publish, fire the publish,
//     measure t_self = (first 'up' event whose txt.node_id matches own)
//     − t_publish_called.
//   - Fully tear down (browser.stop, bonjour.destroy, http close) between
//     trials so each trial sees a cold mDNS daemon path.
//   - One control trial at the end: browse only, do NOT publish, confirm the
//     window expires with zero self-echos (the "blocked" baseline).
//
// What this validates:
//   - that healthy-LAN self-echo latency has a tight distribution (the
//     N=1 result was not a fluke);
//   - that the difference between "echoed" and "not echoed" is unambiguous
//     (the control trial's silence dwarfs the trial latencies);
//   - that the implementation can pick a defensible threshold of the form
//     `max(p95 × 4, floor)` — concrete numbers, not 30 s by gut feel.
//
// What this is NOT:
//   - cross-host (single-machine; loopback on the OS mDNSResponder daemon);
//   - cross-platform (macOS only — Linux/Avahi and Windows still TBD as
//     called out in the design doc);
//   - a stress test of N concurrent self-echoes (the self-filter and
//     fanout spikes already cover that shape).
//
// Output: JSON report on stdout, one-line verdict on stderr — matches
// spike-mdns.mjs / spike-mdns-fetch.mjs / spike-mdns-fanout.mjs convention.

import { Bonjour } from "bonjour-service";
import { performance } from "node:perf_hooks";
import { createServer } from "node:http";

const SERVICE_TYPE = "mycelium";
const LOOPBACK_HOST = "127.0.0.1";
const TRIAL_WINDOW_MS = Number(process.env.SPIKE_TRIAL_WINDOW_MS) || 5_000;
const TRIALS = Math.max(1, Number(process.env.SPIKE_K) || 10);
const TEARDOWN_GUARD_MS = 250; // wait for daemon to settle before next trial
const CONTROL_WINDOW_MS = Number(process.env.SPIKE_CONTROL_WINDOW_MS) || 3_000;

const report = {
  spike: "wave-3-mdns-self-echo-timing",
  started_at: new Date().toISOString(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  package: "bonjour-service + node:http",
  config: {
    trials: TRIALS,
    trial_window_ms: TRIAL_WINDOW_MS,
    control_window_ms: CONTROL_WINDOW_MS,
    teardown_guard_ms: TEARDOWN_GUARD_MS,
  },
  trials: [],
  control: null,
  stats: null,
  recommendation: null,
  notes: [],
};

function startEphemeralHttp() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // The body content is irrelevant for this spike — the question is
      // how fast bonjour echoes the publish, not how fast HTTP works.
      res.writeHead(204, { "Content-Length": "0" });
      res.end();
    });
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(() => resolve()));
}

function destroyBonjour(b) {
  return new Promise((resolve) => {
    try {
      b.destroy(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function runTrial(trialIndex) {
  const ownNodeId = `spike-self-echo-${process.pid}-t${trialIndex}`;
  const instanceName = `mycelium-self-echo-${process.pid}-t${trialIndex}`;
  const { server, port } = await startEphemeralHttp();

  const bonjour = new Bonjour();
  let firstSelfEchoMs = null;
  let extraneousUps = 0;
  const otherUps = [];

  // Browser BEFORE publish — we want to count the self-echo from t_publish,
  // not miss it because we subscribed too late.
  const browser = bonjour.find({ type: SERVICE_TYPE });
  const tPublish = performance.now();

  browser.on("up", (svc) => {
    const t = performance.now();
    const txt = svc?.txt ?? {};
    if (txt.node_id === ownNodeId) {
      if (firstSelfEchoMs === null) {
        firstSelfEchoMs = Math.round(t - tPublish);
      } else {
        // bonjour-service sometimes fires multiple 'up' events for the
        // same service across address families (v4 + v6 + link-local).
        // Count them but only the first one matters for the threshold.
        extraneousUps += 1;
      }
    } else {
      otherUps.push({
        name: svc?.name,
        node_id: txt.node_id ?? null,
        first_seen_ms: Math.round(t - tPublish),
      });
    }
  });

  const service = bonjour.publish({
    name: instanceName,
    type: SERVICE_TYPE,
    port,
    txt: {
      url: `http://${LOOPBACK_HOST}:${port}/.well-known/mycelium-node`,
      node_id: ownNodeId,
      spec: "v1",
    },
  });

  // Wait for self-echo OR timeout — whichever fires first.
  const t0Wait = performance.now();
  while (firstSelfEchoMs === null && performance.now() - t0Wait < TRIAL_WINDOW_MS) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // Tear down: bonjour.unpublish (via service.stop) then browser.stop then
  // bonjour.destroy. Equivalent to a clean process exit.
  await new Promise((resolve) => {
    try {
      service.stop(() => resolve());
    } catch {
      resolve();
    }
  });
  try {
    browser.stop();
  } catch {
    // best-effort; bonjour-service may have already torn this down
  }
  await destroyBonjour(bonjour);
  await closeServer(server);

  return {
    trial: trialIndex,
    own_node_id: ownNodeId,
    self_echo_ms: firstSelfEchoMs,
    timed_out: firstSelfEchoMs === null,
    extraneous_self_ups: extraneousUps,
    other_ups: otherUps.slice(0, 5), // bound the report size
    other_ups_total: otherUps.length,
  };
}

async function runControl() {
  // Browse only — no publish. The window should expire with zero self-echos.
  // This is the "blocked" baseline: from the browser's POV, a network where
  // multicast is blocked looks identical to a network where nothing publishes
  // mycelium services. The threshold's job is to time-out gracefully in
  // both cases.
  const ownNodeId = `spike-self-echo-${process.pid}-control`;
  const bonjour = new Bonjour();
  let selfSeen = false;
  let otherSeen = 0;

  const browser = bonjour.find({ type: SERVICE_TYPE });
  const t0 = performance.now();
  browser.on("up", (svc) => {
    if ((svc?.txt?.node_id ?? null) === ownNodeId) {
      selfSeen = true;
    } else {
      otherSeen += 1;
    }
  });

  while (performance.now() - t0 < CONTROL_WINDOW_MS) {
    await new Promise((r) => setTimeout(r, 50));
  }

  try {
    browser.stop();
  } catch {
    // ignore
  }
  await destroyBonjour(bonjour);

  return {
    own_node_id: ownNodeId,
    window_ms: CONTROL_WINDOW_MS,
    self_seen: selfSeen,
    other_seen: otherSeen,
  };
}

function computeStats(trials) {
  const latencies = trials
    .filter((t) => !t.timed_out && t.self_echo_ms !== null)
    .map((t) => t.self_echo_ms)
    .sort((a, b) => a - b);
  if (latencies.length === 0) {
    return { count: 0, min: null, median: null, p95: null, max: null };
  }
  const idxP95 = Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1);
  const idxMedian = Math.floor(latencies.length / 2);
  return {
    count: latencies.length,
    min: latencies[0],
    median: latencies[idxMedian],
    p95: latencies[idxP95],
    max: latencies[latencies.length - 1],
    all_ms: latencies,
  };
}

function recommendThreshold(stats) {
  // Defensive heuristic: 4× p95 to absorb router jitter, with a floor of
  // 500 ms (sub-second is not user-perceptible) and a ceiling of 5 s
  // (anything longer just slows the "mDNS blocked" warning).
  if (stats.count === 0) {
    return {
      blocked_threshold_ms: null,
      reason: "no successful trials — cannot recommend",
    };
  }
  const computed = stats.p95 * 4;
  const floored = Math.max(500, computed);
  const capped = Math.min(5_000, floored);
  return {
    blocked_threshold_ms: capped,
    reason: `4 × p95 (${stats.p95} ms) = ${computed} ms, floored at 500 ms, capped at 5000 ms → ${capped} ms`,
    safety_margin_over_max: capped - stats.max,
    versus_design_doc_30s: `recommended ${capped} ms is ${(30000 / capped).toFixed(1)}× faster than the doc's 30 000 ms guess`,
  };
}

async function main() {
  process.stderr.write(`spike-mdns-self-echo-timing: K=${TRIALS} trials, ` +
    `window=${TRIAL_WINDOW_MS} ms each, then 1 control trial of ${CONTROL_WINDOW_MS} ms\n`);

  for (let i = 0; i < TRIALS; i += 1) {
    const result = await runTrial(i);
    report.trials.push(result);
    process.stderr.write(
      `  trial ${i}: ` +
      (result.timed_out
        ? `TIMED OUT (no self-echo in ${TRIAL_WINDOW_MS} ms)\n`
        : `self_echo=${result.self_echo_ms} ms` +
          (result.extraneous_self_ups > 0
            ? ` (+${result.extraneous_self_ups} extra self ups)`
            : "") +
          (result.other_ups_total > 0
            ? ` (${result.other_ups_total} other peers seen)`
            : "") +
          "\n")
    );
    await new Promise((r) => setTimeout(r, TEARDOWN_GUARD_MS));
  }

  process.stderr.write(`  control: browse only, no publish, ${CONTROL_WINDOW_MS} ms window...\n`);
  report.control = await runControl();
  process.stderr.write(
    `    self_seen=${report.control.self_seen} (expected: false), ` +
    `other_seen=${report.control.other_seen}\n`
  );

  report.stats = computeStats(report.trials);
  report.recommendation = recommendThreshold(report.stats);

  if (report.control.self_seen) {
    report.notes.push(
      "WARNING: control trial saw its own node_id without publishing — " +
      "browser leak across trials, results untrustworthy"
    );
  }

  if (report.stats.count < TRIALS) {
    report.notes.push(
      `${TRIALS - report.stats.count} of ${TRIALS} trials timed out — ` +
      "self-echo is not as reliable as the N=1 self-filter result suggested"
    );
  }

  if (report.stats.count > 0 && report.stats.max > report.stats.median * 10) {
    report.notes.push(
      `tail latency wide: max=${report.stats.max} ms vs median=${report.stats.median} ms ` +
      "— router jitter or mDNS daemon thrash is a real factor"
    );
  }

  report.finished_at = new Date().toISOString();
  process.stdout.write(JSON.stringify(report, null, 2));
  process.stdout.write("\n");

  const verdict = report.stats.count === 0
    ? "FAILED: no trials surfaced a self-echo"
    : `OK: median=${report.stats.median} ms, p95=${report.stats.p95} ms, ` +
      `max=${report.stats.max} ms (n=${report.stats.count}/${TRIALS}); ` +
      `recommend ${report.recommendation.blocked_threshold_ms} ms ` +
      `vs doc's 30 000 ms`;
  process.stderr.write(verdict + "\n");
}

main().catch((err) => {
  process.stderr.write(`spike crashed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
