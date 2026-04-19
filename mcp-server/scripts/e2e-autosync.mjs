// E2E Phase 3f: peer_upsert + manual Auto-Sync-Loop-Call + Status-Aggregator.
// Wir testen, dass der Loop einen auto_sync_enabled peer tatsächlich syncht
// und die peers_list-Felder entsprechend updated werden.
import { execSync } from "node:child_process";
import { FederationService } from "../dist/services/federation.js";
import { GuardService } from "../dist/services/guard.js";
import { IdentityService } from "../dist/services/identity.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const guard = new GuardService(process.env.GUARD_URL ?? "http://127.0.0.1:18793", 4000);
const fed = new FederationService(url, key, guard, "test-host");
const id = new IdentityService(url, key);

const HOST = "127.0.0.1";
const PORT = 8788;

function sqlExec(sql) { execSync(`docker exec vectormemory-db psql -U postgres -d vectormemory -c "${sql}"`, { stdio: "ignore" }); }
function header(s) { console.log(`\n=== ${s} ===`); }
function say(k, v) { console.log(`  ${k.padEnd(28)} ${v}`); }

// 1. Ensure our own host pubkey is a peer with outbound config.
header("1. Register self as outbound peer");
const hostPub = "ce98147bef2d81e7419c35cdc74abae074004c15fe41370c93884b8fbfce32e2";
await fed.peerUpsert({
  pubkey_hex: hostPub, label: "self-loop-autosync",
  outbound_host: HOST, outbound_port: PORT,
  auto_sync_enabled: true,
});
const peers = await fed.peersList(true);
say("autosync peers:", peers.length);
say("first peer:", peers[0].label);

// 2. Issue a test revocation so the sync has something to fetch.
header("2. Seed a test revocation");
const labelX = `e2e-autosync-x-${Date.now()}`;
const mainG = await id.getGenome("main");
const lab01G = await id.getGenome("lab01");
const x = await id.createGenomeFromBreeding({
  label: labelX, parent_a: mainG, parent_b: lab01G, mutation_rate: 0.05, inheritance_mode: "top",
});
const xStatus = await id.genomePkiStatus(labelX);
await id.issueRevocation({
  target_pubkey_hex: xStatus.pubkey_hex, reason: "e2e autosync test", signer_label: labelX,
});
say("issued revocation for:", xStatus.pubkey_hex.slice(0, 16) + "…");

// 3. Manually trigger the same thing the dashboard cron does: iterate
//    autosync peers and call syncRevocations for each.
header("3. Manual auto-sync loop");
let synced = 0, ok = 0;
for (const p of peers) {
  if (!p.outbound_host || !p.outbound_port) continue;
  synced++;
  try {
    const r = await fed.syncRevocations({ host: p.outbound_host, port: p.outbound_port });
    await fed.peerRecordSync(p.pubkey_hex, true, `fetched=${r.fetched} accepted=${r.accepted} skipped=${r.skipped_already_known}`);
    ok++;
    say("→ " + p.label, `fetched=${r.fetched} accepted=${r.accepted} skipped=${r.skipped_already_known}`);
  } catch (e) {
    await fed.peerRecordSync(p.pubkey_hex, false, (e instanceof Error ? e.message : String(e)).slice(0, 160));
    say("→ " + p.label, "FAILED: " + (e instanceof Error ? e.message : String(e)).slice(0, 100));
  }
}
say("total:", `synced=${synced} ok=${ok}`);

// 4. Check that peer_record_sync updated the row correctly.
header("4. Verify peers_list after sync");
const after = await fed.peersList(true);
const updated = after.find((p) => p.pubkey_hex === hostPub);
say("last_auto_sync_at:", updated?.last_auto_sync_at);
say("last_auto_sync_ok:", updated?.last_auto_sync_ok);
say("note:", updated?.last_auto_sync_note);

// 5. Audit cleanup smoke test (0 rows, but exercises the code path)
header("5. Audit cleanup (dry — should delete 0 rows older than 90d)");
const cleanup = await fed.federationAuditCleanup(90);
say("imports deleted:", cleanup.imports_deleted);
say("exports deleted:", cleanup.exports_deleted);

// 6. Cleanup
header("Cleanup");
sqlExec(`UPDATE peers SET auto_sync_enabled=false, outbound_host=NULL, outbound_port=NULL WHERE pubkey=decode('${hostPub}','hex');`);
sqlExec(`DELETE FROM revoked_keys WHERE pubkey=decode('${xStatus.pubkey_hex}','hex');`);
sqlExec(`DELETE FROM agent_genomes WHERE label LIKE 'e2e-autosync%';`);
say("done.", "");
