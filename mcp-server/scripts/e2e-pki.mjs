// E2E: zwei (Eltern-)Genome paaren → Kind erbt Centroid + bekommt Birth-Cert + Profile-Sig.
// Verifiziert alle drei Genome danach.
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { IdentityService } from "../dist/services/identity.js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_KEY ?? "";
const id = new IdentityService(url, key);

const childLabel = `e2e-pki-${Date.now()}`;

const main  = await id.getGenome("main");
const lab01 = await id.getGenome("lab01");
console.log("parents:", main.label, "+", lab01.label);

console.log("\n-- breed --");
const child = await id.createGenomeFromBreeding({
  label: childLabel,
  parent_a: main,
  parent_b: lab01,
  mutation_rate: 0.05,
  inheritance_mode: "top",
  notes: "e2e-pki test",
});
console.log("child created:", child.label, "gen", child.generation, "id", child.id.slice(0, 8));

console.log("\n-- verify child --");
const v = await id.verifyGenome(childLabel);
console.log("  pubkey:                     ", v.has_pubkey);
console.log("  profile_signature_valid:    ", v.profile_signature_valid);
console.log("  birth_certificate_present:  ", v.birth_certificate_present);
console.log("  birth_certificate_valid:    ", v.birth_certificate_valid);
console.log("  notes:                      ", v.notes);

console.log("\n-- tamper test: edit profile, verify should fail --");
// Setze frech die "values" um — der ursprüngliche Sig sollte invalid werden
import("@supabase/postgrest-js").then(async ({ PostgrestClient }) => {
  const db = new PostgrestClient(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  await db.from("agent_genomes")
    .update({ values: ["unrelated", "tampered"] })
    .eq("label", childLabel);
  const v2 = await id.verifyGenome(childLabel);
  console.log("  after tamper, profile_sig valid:", v2.profile_signature_valid, "(should be false)");

  console.log("\n-- cleanup --");
  await db.from("agent_genomes").delete().eq("label", childLabel);
  try { await unlink(join(homedir(), ".openclaw", "keys", `${child.id}.key`)); } catch {}
  console.log("  child genome + privkey removed");
});
