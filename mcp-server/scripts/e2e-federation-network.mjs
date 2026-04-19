// E2E Phase 3b: Netzwerk-Round-Trip via mTLS.
// Baut ein Test-Kind, pushed es an sich selbst (self-loop), pulled es danach.

import { execSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { IdentityService } from "../dist/services/identity.js";
import { FederationService } from "../dist/services/federation.js";
import { GuardService } from "../dist/services/guard.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const id  = new IdentityService(url, key);
const guard = new GuardService(process.env.GUARD_URL ?? "http://127.0.0.1:18793", 4000);
const fed = new FederationService(url, key, guard, "test-host");

const HOST = process.env.FED_HOST || "127.0.0.1";
const PORT = Number(process.env.FED_PORT || 8788);

function sqlExec(sql) {
  execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" });
}

function header(s) { console.log(`\n=== ${s} ===`); }
function say(label, value) { console.log(`  ${label.padEnd(30)} ${value}`); }

// 1. Test-Kind erzeugen
header("1. Breed test child");
const main = await id.getGenome("main");
const lab01 = await id.getGenome("lab01");
const childLabel = `e2e-net-${Date.now()}`;
const child = await id.createGenomeFromBreeding({
  label: childLabel, parent_a: main, parent_b: lab01,
  mutation_rate: 0.05, inheritance_mode: "top",
});
say("child label:", child.label);
say("child id:", child.id);

// 2. Trust-Root: main.pubkey (für Lineage-Trust beim Import)
header("2. Seed trust roots");
const mainStatus = await id.genomePkiStatus("main");
await fed.trustAdd({
  kind: "genome", identifier: "e2e-enrico-main", pubkey_hex: mainStatus.pubkey_hex,
  label: "lineage root for e2e net test",
});
say("main.pub as trust:", mainStatus.pubkey_hex.slice(0, 24) + "…");
// (self host-pubkey ist bereits trust_roots[kind=host,identifier='self'])

// 3. Netzwerk-Pull (mit Kind noch lokal) — testet round-trip, erwarte idempotent-skip.
header("3. Pull child (still local) → expect idempotent-skip rejection");
const pullResult = await fed.pull({ host: HOST, port: PORT, label: childLabel });
say("decision:", pullResult.decision);
say("reason:", pullResult.reason);
say("trust_root:", pullResult.trust_root_pubkey_hex?.slice(0, 24) + "…");

// 4. Netzwerk-Push — dasselbe Kind an sich selbst pushen. Server schickt
//    es durch importBundle und sieht ebenfalls idempotent-skip.
header("4. Push local child → expect peer idempotent-skip");
const pushResult = await fed.push({ host: HOST, port: PORT, label: childLabel });
say("peer status:", pushResult.peer_status);
say("peer decision:", pushResult.peer_verdict.decision);
say("peer reason:", pushResult.peer_verdict.reason);

// 5. Delete locally, then pull freshly → echtes ACCEPTED. Self-loop heißt
//    aber: sobald wir das Kind löschen, kann der Peer es auch nicht mehr
//    exportieren. Wir simulieren also einen echten Pull indem wir vorher
//    das Bundle einmal off-line speichern.
header("5. Offline-roundtrip: export → delete → re-import via push");
const exp = await fed.exportBundle(childLabel, { destination: "offline-test" });
sqlExec(`DELETE FROM agent_genomes WHERE label='${childLabel}'`);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
// jetzt ist das Kind weg. Peer (= wir selbst) bekommt das Bundle und soll akzeptieren.
import("node:https").then(async ({ default: https }) => {
  const { readFileSync } = await import("node:fs");
  const keysDir = join(homedir(), ".openclaw", "keys");
  const cert = readFileSync(join(keysDir, "host.crt"));
  const key  = readFileSync(join(keysDir, "host.key"));
  const body = JSON.stringify({ bundle: exp.bundle });
  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, port: PORT, path: "/federation/import", method: "POST",
      cert, key, rejectUnauthorized: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("error", reject); req.write(body); req.end();
  });
  say("HTTPS POST status:", result.status);
  const v = JSON.parse(result.body);
  say("peer decision:", v.decision);
  say("peer reason:", v.reason);
});

// 5. Cleanup
header("5. Cleanup");
sqlExec(`DELETE FROM revoked_keys; DELETE FROM trust_roots WHERE identifier='e2e-enrico-main'; DELETE FROM agent_genomes WHERE label='${childLabel}'`);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
say("done.", "");
