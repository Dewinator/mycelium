// E2E Phase 3d: Signed Revocations + Federation-Sync.
// Szenarien:
//   A) Erzeuge Test-Genome X, issue SELF-REVOCATION für X (signed by X).
//   B) Sync von uns zu uns → idempotent (bereits bekannt).
//   C) Tamper: manipuliere signature in revoked_keys → sync erkennt + rejected.
//   D) No-authority: erzeuge Test-Genome Y (no trust-root), issue-Versuch für X mit Y als signer → refused.

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

function sqlExec(sql) { execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" }); }
function sqlQuery(sql) { return execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -At -c "${sql}"`, { encoding: "utf8" }).trim(); }
function header(s) { console.log(`\n=== ${s} ===`); }
function say(k, v) { console.log(`  ${k.padEnd(30)} ${v}`); }

// --- A: Test-Genome X erzeugen, self-revoke ---
header("A. Create test genome X + self-revoke");
const mainG = await id.getGenome("main");
const lab01G = await id.getGenome("lab01");
const labelX = `e2e-rev-x-${Date.now()}`;
const x = await id.createGenomeFromBreeding({
  label: labelX, parent_a: mainG, parent_b: lab01G, mutation_rate: 0.05, inheritance_mode: "top",
});
const xStatus = await id.genomePkiStatus(labelX);
say("X pubkey:", xStatus.pubkey_hex.slice(0, 24) + "…");
const r1 = await id.issueRevocation({
  target_pubkey_hex: xStatus.pubkey_hex, reason: "test: self revoke X", signer_label: labelX, revoked_by: "e2e",
});
say("issued sig:", r1.signature_hex.slice(0, 24) + "…");
const stored = sqlQuery(`SELECT encode(signature,'hex') FROM revoked_keys WHERE pubkey=decode('${xStatus.pubkey_hex}','hex');`);
say("stored sig in DB:", stored.slice(0, 24) + "…");

// --- B: federation_sync_revocations gegen self → idempotent ---
header("B. Sync revocations from self → expect all known (skipped)");
const sync1 = await fed.syncRevocations({ host: HOST, port: PORT });
say("fetched:", sync1.fetched);
say("accepted:", sync1.accepted);
say("skipped (known):", sync1.skipped_already_known);
say("rejected (any):", sync1.rejected_bad_sig + sync1.rejected_no_authority + sync1.rejected_malformed);

// --- C: tamper signature in DB, resync → rejected_bad_sig ---
header("C. Tamper signature in DB → sync should reject");
sqlExec(`UPDATE revoked_keys SET signature = decode('${"ff".repeat(64)}','hex') WHERE pubkey=decode('${xStatus.pubkey_hex}','hex');`);
// Purge the target's local row so that sync tries to apply again (otherwise "skipped as known")
// Actually: sync detects tampered sig via signature-verify, not via presence. Let's verify.
const sync2 = await fed.syncRevocations({ host: HOST, port: PORT });
say("fetched:", sync2.fetched);
say("rejected (bad sig):", sync2.rejected_bad_sig);
say("accepted:", sync2.accepted);

// --- D: No-authority test — erzeuge Y (kein trust-root), try revoke X via Y ---
header("D. No-authority issue attempt (Y tries to revoke X)");
const labelY = `e2e-rev-y-${Date.now()}`;
const y = await id.createGenomeFromBreeding({
  label: labelY, parent_a: mainG, parent_b: lab01G, mutation_rate: 0.05, inheritance_mode: "top",
});
const yStatus = await id.genomePkiStatus(labelY);
try {
  await id.issueRevocation({
    target_pubkey_hex: xStatus.pubkey_hex, reason: "Y tries to revoke X", signer_label: labelY,
  });
  say("RESULT:", "UNEXPECTED SUCCESS (bug?)");
} catch (e) {
  say("refused:", e.message.slice(0, 100));
}

// --- Cleanup ---
header("Cleanup");
sqlExec(`DELETE FROM revoked_keys WHERE pubkey IN (decode('${xStatus.pubkey_hex}','hex'), decode('${yStatus.pubkey_hex}','hex'));`);
sqlExec(`DELETE FROM agent_genomes WHERE label LIKE 'e2e-rev-%';`);
try { await unlink(join(homedir(), ".openclaw", "keys", `${x.id}.key`)); } catch {}
try { await unlink(join(homedir(), ".openclaw", "keys", `${y.id}.key`)); } catch {}
say("done.", "");
