// One-shot: keygen + signProfile + refreshMemoryMerkle für bestehende Gen-1 Genome.
// Re-run safe: keygen ist idempotent (refuses overwrite ohne force).
import { IdentityService } from "../dist/services/identity.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const id = new IdentityService(url, key);

const labels = process.argv.slice(2);
if (labels.length === 0) {
  console.error("usage: node backfill-pki.mjs <label1> [<label2> ...]");
  process.exit(1);
}

for (const label of labels) {
  console.log(`\n== ${label} ==`);
  try {
    const k = await id.genomeKeygen(label, false);
    console.log(`  keygen: ${k.created ? "CREATED" : "exists"} pub=${k.pubkey_hex.slice(0, 16)}…`);
    const s = await id.signProfile(label);
    console.log(`  signed profile: ${s.sig_hex.slice(0, 16)}…`);
    const m = await id.refreshMemoryMerkle(label);
    console.log(`  merkle: n=${m.n} root=${m.root_hex.slice(0, 16)}…`);
    const v = await id.verifyGenome(label, { spotcheck_merkle: true });
    console.log(`  verify: pubkey=${v.has_pubkey} profile_sig=${v.profile_signature_valid} merkle_match=${v.memory_merkle_match}`);
    if (v.notes.length) console.log(`  notes: ${v.notes.join("; ")}`);
  } catch (e) {
    console.error(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
  }
}
