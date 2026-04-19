// E2E Phase 3c: Proof-of-Memory (PoM) über mTLS.
// Szenarien:
//  A) Pull main (544 Memories) über Netz → PoM mit K=5 Inclusion-Proofs → accepted.
//  B) Bundle mit manipulierter memory_merkle_root → PoM schlägt fehl.

import { execSync } from "node:child_process";
import https from "node:https";
import { readFileSync } from "node:fs";
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
function say(k, v) { console.log(`  ${k.padEnd(30)} ${v}`); }

// ----- Szenario A: main ist lokal vorhanden, hat 544 Memories + Merkle --------
header("A. Pull main → PoM happy path (self-loop expects idempotent-skip AFTER PoM passes)");
// Trust-Root: main.pubkey selbst (chain-of-one). Host-Cert ist schon self-trusted.
const mainStatus = await id.genomePkiStatus("main");
sqlExec(`DELETE FROM trust_roots WHERE identifier='e2e-pom';`);
await fed.trustAdd({
  kind: "genome", identifier: "e2e-pom", pubkey_hex: mainStatus.pubkey_hex, label: "e2e-pom root",
});

const verdict = await fed.pull({ host: HOST, port: PORT, label: "main", pom_k: 5 });
say("decision:", verdict.decision);
say("reason:", verdict.reason);
say("PoM result:", JSON.stringify(verdict.guard_verdicts._pom ?? {}));

// ----- Szenario B: Bundle mit verbogener merkle_root → PoM failed -------------
header("B. Export main, tamper merkle_root, push via HTTPS → PoM fails");
// Wir exportieren main lokal, ersetzen die root, und versuchen das bundle
// via POST /federation/import auf unseren eigenen Peer zu pushen.
const exp = await fed.exportBundle("main", { destination: "e2e-pom-tamper" });
// Tamper:
const orig = exp.bundle.root.genome.memory_merkle_root_hex;
exp.bundle.root.genome.memory_merkle_root_hex = "ff".repeat(32);
say("original root:", orig.slice(0, 16) + "…");
say("tampered root:", "ff".repeat(16) + "…");

// Push via raw HTTPS mit own cert als Client. Server wird das Bundle
// verifizieren — die Sig-Chain prüft den profile_payload, der den
// profile_embedding_sha256 enthält, NICHT die memory_merkle_root. Also
// wird die Chain-Verify durchgehen, aber PoM sollte (wenn auf Push-Flow
// aktiviert wäre) fehlschlagen. Auf Push-Flow haben wir PoM NICHT, also
// testet dieser Case eigentlich die pull-Seite von der ANDEREN Seite.
//
// Stattdessen: wir nutzen die pull-Seite indem wir auf einen MANIPULIERTEN
// server antworten würden. Da wir nur uns selbst haben, simulieren wir:
// wir rufen die _runPomChallenge direkt mit einer falschen claimed_root.
header("B (variant). Direct PoM call with wrong claimed root");
// Zugriff auf private method via Prototype-Trick — PoM-Antwort soll fehlschlagen.
const pomResult = await fed._runPomChallenge({
  host: HOST, port: PORT,
  label: "main",
  claimed_root_hex: "ff".repeat(32),
  n: mainStatus.memory_merkle_n,
  k: 5,
});
say("pom ok:", pomResult.ok);
say("pom reason:", pomResult.reason);

// ----- Szenario C: Direct PoM mit korrekter Root → bestanden ------------------
header("C. Direct PoM call with correct root → all proofs verify");
const realRoot = mainStatus.memory_merkle_root_hex;
const pom2 = await fed._runPomChallenge({
  host: HOST, port: PORT,
  label: "main",
  claimed_root_hex: realRoot,
  n: mainStatus.memory_merkle_n,
  k: 5,
});
say("pom ok:", pom2.ok);
say("pom reason:", pom2.reason);
say("proofs:", `${pom2.proofs_verified}/${pom2.proofs_total}`);

// ----- Cleanup ---------------------------------------------------------------
header("Cleanup");
sqlExec(`DELETE FROM trust_roots WHERE identifier='e2e-pom';`);
say("done.", "");
