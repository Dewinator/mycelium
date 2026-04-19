// tls-host.mjs — Self-signed Ed25519 X.509 für mTLS-Federation.
//
// Verwendet Homebrew-OpenSSL (LibreSSL hat kein Ed25519). Pfad konfigurierbar
// über OPENSSL_BIN. Generiert genau einmal ~/.openclaw/keys/host.{key,crt}
// und meldet Pubkey + Cert-Fingerprint an die DB.
//
// Wir laufen als reines ESM-Skript (.mjs) — der Dashboard-Server importiert
// uns; der MCP-Server (TypeScript) braucht das nicht.

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, X509Certificate } from "node:crypto";

const OPENSSL = process.env.OPENSSL_BIN ?? "/opt/homebrew/bin/openssl";
const KEYS_DIR = process.env.OPENCLAW_KEYS_DIR ?? join(homedir(), ".openclaw", "keys");
const KEY_PATH = join(KEYS_DIR, "host.key");
const CRT_PATH = join(KEYS_DIR, "host.crt");

function ensureOpensslAvailable() {
  try {
    const v = execFileSync(OPENSSL, ["version"], { encoding: "utf8" }).trim();
    if (!v.includes("OpenSSL 3")) {
      throw new Error(`expected OpenSSL 3.x for Ed25519, got: ${v} (set OPENSSL_BIN to a working binary)`);
    }
    return v;
  } catch (e) {
    throw new Error(`openssl not usable at ${OPENSSL}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Ensures a self-signed Ed25519 cert exists under ~/.openclaw/keys/host.{key,crt}.
 *  Returns { keyPath, crtPath, pubkeyHex, fingerprintHex, certPem }. */
export function ensureHostCert(label) {
  ensureOpensslAvailable();
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(KEY_PATH) || !existsSync(CRT_PATH)) {
    execFileSync(OPENSSL, ["genpkey", "-algorithm", "Ed25519", "-out", KEY_PATH], { stdio: "ignore" });
    chmodSync(KEY_PATH, 0o600);
    execFileSync(OPENSSL, [
      "req", "-new", "-x509",
      "-key", KEY_PATH,
      "-out", CRT_PATH,
      "-days", "3650",
      "-subj", `/CN=${label}/O=openclaw-federation`,
    ], { stdio: "ignore" });
  }
  const certPem = readFileSync(CRT_PATH, "utf8");
  const cert    = new X509Certificate(certPem);
  // Ed25519 raw 32-byte pubkey: last 32 bytes of SPKI DER.
  const spkiDer = cert.publicKey.export({ type: "spki", format: "der" });
  const pubkey  = spkiDer.subarray(spkiDer.length - 32);
  const fingerprint = createHash("sha256").update(cert.raw).digest();
  return {
    keyPath: KEY_PATH,
    crtPath: CRT_PATH,
    pubkeyHex: pubkey.toString("hex"),
    fingerprintHex: fingerprint.toString("hex"),
    certPem,
    notAfter: cert.validTo,
  };
}

/** Extracts a peer's Ed25519 raw pubkey from its X509Certificate. */
export function peerPubkeyFromCert(certInfo) {
  // certInfo can be a plain object from getPeerCertificate(true), with .raw (DER)
  if (!certInfo || !certInfo.raw) return null;
  try {
    const cert = new X509Certificate(certInfo.raw);
    const spki = cert.publicKey.export({ type: "spki", format: "der" });
    if (spki.length < 32) return null;
    return spki.subarray(spki.length - 32);
  } catch {
    return null;
  }
}

export function peerCertFingerprint(certInfo) {
  if (!certInfo || !certInfo.raw) return null;
  return createHash("sha256").update(certInfo.raw).digest();
}

export const HOST_KEY_PATH = KEY_PATH;
export const HOST_CRT_PATH = CRT_PATH;
