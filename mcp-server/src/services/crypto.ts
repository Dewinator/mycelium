/**
 * Crypto-Service für PKI + Lineage-Signaturen (Phase 1 Trust-Modell A).
 *
 *   - Ed25519-Schlüsselpaare für jedes Genome (Privkey nur im FS, Pubkey in DB).
 *   - Profil-Self-Signaturen (Tampering-Schutz).
 *   - Birth-Certificates: beide Eltern signieren ein gemeinsames Payload für das Kind.
 *   - Memory-Provenance via SHA-256 Merkle-Tree.
 *
 * Kein externer Crypto-Dep — alles aus node:crypto.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const KEYS_DIR = process.env.OPENCLAW_KEYS_DIR ?? join(homedir(), ".openclaw", "keys");

export interface Keypair {
  pubkeyRaw: Buffer;       // 32 Byte raw Ed25519 public key
  privateKey: KeyObject;   // node:crypto KeyObject (PKCS8 intern)
}

export interface Signature {
  bytes: Buffer;           // 64 Byte
  hex: string;
}

/** Stable canonical JSON serialization — sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k])).join(",") + "}";
}

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

// ---------------------------------------------------------------------------
// Keypair gen + IO
// ---------------------------------------------------------------------------

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // Ed25519 raw pubkey: letzte 32 Byte des SPKI-DER
  const spki = publicKey.export({ type: "spki", format: "der" });
  const pubkeyRaw = Buffer.from(spki.subarray(spki.length - 32));
  return { pubkeyRaw, privateKey };
}

function privkeyPath(genomeId: string): string {
  return join(KEYS_DIR, `${genomeId}.key`);
}

/** Speichert Privkey im PEM/PKCS8-Format mit 0600. */
export async function savePrivkey(genomeId: string, key: KeyObject): Promise<string> {
  await mkdir(KEYS_DIR, { recursive: true, mode: 0o700 });
  const pem = key.export({ type: "pkcs8", format: "pem" }) as string;
  const path = privkeyPath(genomeId);
  await writeFile(path, pem, { mode: 0o600 });
  return path;
}

export async function loadPrivkey(genomeId: string): Promise<KeyObject | null> {
  const path = privkeyPath(genomeId);
  try {
    const pem = await readFile(path, "utf8");
    return createPrivateKey(pem);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export async function privkeyExists(genomeId: string): Promise<boolean> {
  try {
    await stat(privkeyPath(genomeId));
    return true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Sign / Verify (Ed25519, raw 32-byte pubkey)
// ---------------------------------------------------------------------------

/** Aus rohem 32-byte Ed25519-Pubkey ein KeyObject bauen (für nodeVerify). */
export function pubkeyFromRaw(raw: Buffer): KeyObject {
  // SPKI DER für Ed25519: 12-byte Header + 32-byte raw
  const SPKI_HEADER = Buffer.from([
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
  ]);
  const der = Buffer.concat([SPKI_HEADER, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export function sign(privateKey: KeyObject, data: Buffer): Signature {
  const sig = nodeSign(null, data, privateKey);
  return { bytes: sig, hex: sig.toString("hex") };
}

export function verify(pubkeyRaw: Buffer, data: Buffer, signature: Buffer): boolean {
  try {
    return nodeVerify(null, data, pubkeyFromRaw(pubkeyRaw), signature);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Merkle-Tree (sha256 binary)
// ---------------------------------------------------------------------------

export interface MerkleProof {
  leaf: Buffer;          // hash of the leaf data
  index: number;         // 0-based
  siblings: Buffer[];    // bottom-up
}

export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) return Buffer.alloc(32, 0);
  let layer = leaves.slice();
  while (layer.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(sha256(Buffer.concat([left, right])));
    }
    layer = next;
  }
  return layer[0];
}

export function merkleProof(leaves: Buffer[], index: number): MerkleProof {
  if (index < 0 || index >= leaves.length) throw new Error(`merkle index ${index} out of range`);
  const siblings: Buffer[] = [];
  let layer = leaves.slice();
  let idx = index;
  const leaf = leaves[index];
  while (layer.length > 1) {
    const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    siblings.push(sibIdx < layer.length ? layer[sibIdx] : layer[idx]);
    const next: Buffer[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];
      next.push(sha256(Buffer.concat([left, right])));
    }
    layer = next;
    idx = Math.floor(idx / 2);
  }
  return { leaf, index, siblings };
}

export function verifyMerkleProof(root: Buffer, proof: MerkleProof): boolean {
  let h = proof.leaf;
  let idx = proof.index;
  for (const sib of proof.siblings) {
    h = idx % 2 === 0 ? sha256(Buffer.concat([h, sib])) : sha256(Buffer.concat([sib, h]));
    idx = Math.floor(idx / 2);
  }
  return h.equals(root);
}

// ---------------------------------------------------------------------------
// Birth-Certificate Payload
// ---------------------------------------------------------------------------

export interface BirthCertPayload {
  v: 1;
  child_id: string;
  child_label: string;
  child_pubkey_hex: string;
  parent_a: { id: string; label: string; pubkey_hex: string };
  parent_b: { id: string; label: string; pubkey_hex: string };
  inheritance_mode: "none" | "top" | "full";
  mutation_rate: number;
  born_at: string;             // ISO
}

export function buildBirthCertPayload(input: BirthCertPayload): Buffer {
  return Buffer.from(canonicalJson(input), "utf8");
}

export interface BirthCert {
  v: 1;
  payload: BirthCertPayload;
  parent_a_sig_hex: string;
  parent_b_sig_hex: string;
}

// ---------------------------------------------------------------------------
// Signed Revocation Payload (Phase 3d)
// ---------------------------------------------------------------------------

export interface RevocationPayload {
  v: 1;
  revoked_pubkey_hex: string;
  signer_pubkey_hex: string;
  reason: string;
  revoked_at: string;      // ISO 8601
}

export function buildRevocationPayload(input: RevocationPayload): Buffer {
  return Buffer.from(canonicalJson(input), "utf8");
}
