// E2E Phase 2: Trust-Roots + Federation-Bundle Round-Trip + Negativ-Tests.
//
// Plan:
//   1. Erzeuge Gen-2 Test-Genom (main × lab01) — bekommt automatisch PKI.
//   2. Trust-Root: füge main.pubkey hinzu (jeder Nachfahre von main wird trusted).
//   3. Export Test-Genom als Bundle.
//   4. Lösche Test-Genom lokal (privkey-File auch).
//   5. Import → erwarte ACCEPTED.
//   6. Negativ A: Import-Versuch ohne Trust-Root → erwarte REJECTED.
//   7. Negativ B: Tamper bundle (verändere ein values-Feld) → erwarte REJECTED (chain).
//   8. Negativ C: Revoke main, versuche Import → erwarte REJECTED (revoked).
//   9. Cleanup.

import { execSync } from "node:child_process";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "@supabase/postgrest-js";

function sqlDelete(label) {
  // PostgREST has no DELETE grant on agent_genomes — go direct via psql.
  execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "DELETE FROM agent_genomes WHERE label='${label}'"`, { stdio: "ignore" });
}
const { PostgrestClient } = pkg;
import { IdentityService } from "../dist/services/identity.js";
import { FederationService } from "../dist/services/federation.js";
import { GuardService } from "../dist/services/guard.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const id = new IdentityService(url, key);
const guard = new GuardService(process.env.GUARD_URL ?? "http://127.0.0.1:18793", 4000);
const fed = new FederationService(url, key, guard, "test-host");
const db = new PostgrestClient(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });

function header(s) { console.log(`\n=== ${s} ===`); }
function say(label, value) { console.log(`  ${label.padEnd(30)} ${value}`); }

// 1. Test-Kind erzeugen
header("1. Breed test child");
const main = await id.getGenome("main");
const lab01 = await id.getGenome("lab01");
const childLabel = `e2e-fed-${Date.now()}`;
const child = await id.createGenomeFromBreeding({
  label: childLabel, parent_a: main, parent_b: lab01,
  mutation_rate: 0.05, inheritance_mode: "top",
});
say("child label:", child.label);
say("child id:", child.id);
const v0 = await id.verifyGenome(childLabel);
say("verify ok:", `pub=${v0.has_pubkey} sig=${v0.profile_signature_valid} bc=${v0.birth_certificate_valid}`);

// 2. Trust-Root: main.pubkey
header("2. Add trust root (main.pubkey)");
const mainStatus = await id.genomePkiStatus("main");
const mainPubHex = mainStatus.pubkey_hex;
say("main pubkey:", mainPubHex.slice(0, 24) + "…");
await fed.trustAdd({
  kind: "genome", identifier: "enrico-main", pubkey_hex: mainPubHex,
  label: "Main genome (Gen-1 root of trust for local lineage)",
  added_by: "e2e-script",
});
say("trust roots:", (await fed.trustList()).length);

// 3. Export
header("3. Export bundle");
const exp = await fed.exportBundle(childLabel, { destination: "test-target", exported_by: "e2e-script" });
say("bundle hash:", exp.bundle_hash_hex.slice(0, 24) + "…");
say("bundle size:", `${exp.bundle_size} bytes`);
say("lineage len:", exp.bundle.lineage.length);
const bundleJson = JSON.stringify(exp.bundle);

// 4. Lokal löschen
header("4. Delete child locally");
sqlDelete(childLabel);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
say("removed:", "row + privkey");

// 5. Import (positive)
header("5. Import (with trust root) → expect ACCEPTED");
// Debug: confirm child really gone
const { data: present } = await db.from("agent_genomes").select("id,label").eq("label", childLabel);
say("DEBUG present?:", JSON.stringify(present));
const { data: presentById } = await db.from("agent_genomes").select("id,label").eq("id", child.id);
say("DEBUG by id?:", JSON.stringify(presentById));
const v1 = await fed.importBundle(JSON.parse(bundleJson));
say("decision:", v1.decision);
say("reason:", v1.reason);
say("trust_root:", v1.trust_root_pubkey_hex?.slice(0, 24) + "…");

// 6. Negative A: kein Trust-Root
header("6. Import without trust root → expect REJECTED");
await fed.trustRevoke({ pubkey_hex: mainPubHex, reason: "test: temporarily lift trust", revoked_by: "e2e-script" });
// Kind muss erst gelöscht werden, sonst "already exists" maskiert die Ablehnung
sqlDelete(childLabel);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
const v2 = await fed.importBundle(JSON.parse(bundleJson));
say("decision:", v2.decision);
say("reason:", v2.reason);

// Re-add trust for next test (use a different identifier label, key still revoked → must un-revoke)
await db.from("revoked_keys").delete().eq("pubkey", "\\x" + mainPubHex);
await db.from("trust_roots").update({ status: "active" }).eq("pubkey", "\\x" + mainPubHex);

// 7. Negative B: Tamper bundle
header("7. Tamper bundle → expect chain-verify REJECTED");
const tampered = JSON.parse(bundleJson);
tampered.root.genome.values = ["INJECTED", "VALUES"];
const v3 = await fed.importBundle(tampered);
say("decision:", v3.decision);
say("reason:", v3.reason);

// 8. Negative C: Revoke main and try clean import
header("8. Revoke main, then import → expect revoked-key REJECTED");
await fed.trustRevoke({ pubkey_hex: mainPubHex, reason: "test revocation", revoked_by: "e2e-script" });
const v4 = await fed.importBundle(JSON.parse(bundleJson));
say("decision:", v4.decision);
say("reason:", v4.reason);

// 9. Cleanup
header("9. Cleanup");
await db.from("revoked_keys").delete().eq("pubkey", "\\x" + mainPubHex);
await db.from("trust_roots").delete().eq("pubkey", "\\x" + mainPubHex);
sqlDelete(childLabel);
try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
// Audit-Einträge bewusst behalten als Forensik-Beleg
say("audit entries:", (await fed.federationRecent(10)).filter(r => r.genome_label === childLabel).length);
say("done.", "");
