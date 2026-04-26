/**
 * Federation-Service (Phase 2 Trust-Modell A) — kein Netz, nur Crypto + Audit.
 *
 *   - exportBundle(label, options) → JSON-Bundle mit Genom + signierter Lineage
 *     bis zu einem (selbst-deklarierten) Wurzel-Genom. Privkeys verlassen den
 *     Host nie.
 *   - importBundle(bundle, options) → verifiziert Lineage-Signaturen, sucht
 *     einen aktiven Trust-Root in der Kette, prüft Revocation, klassifiziert
 *     Text-Felder via guard.classify_content, schreibt das Genom mit
 *     federated_from in die DB. Jede Entscheidung landet im Audit.
 *
 *   Nichts in dieser Datei öffnet einen Netzwerk-Port. Phase 3 setzt darauf.
 */
import { PostgrestClient } from "@supabase/postgrest-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import {
  buildBirthCertPayload,
  buildRevocationPayload,
  canonicalJson,
  sha256,
  verify,
  type BirthCert,
  type RevocationPayload,
} from "./crypto.js";
import type { GuardService } from "./guard.js";

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string };
  return e.message || e.details || e.hint || JSON.stringify(err);
}

// ---------------------------------------------------------------------------
// Bundle types
// ---------------------------------------------------------------------------

export interface GenomeNodeBundle {
  // exact subset mirrored to/from agent_genomes
  genome: {
    id: string;
    label: string;
    generation: number;
    parent_ids: string[];
    values: string[];
    interests: string[];
    curiosity_baseline: number;
    frustration_threshold: number;
    exploration_rate: number;
    risk_tolerance: number;
    mutation_rate: number;
    notes: string | null;
    pubkey_hex: string;
    profile_signature_hex: string;
    profile_embedding: number[] | null;
    memory_merkle_root_hex: string | null;
    memory_merkle_n: number | null;
  };
  /** The exact JSON payload (object) that the profile_signature was computed over.
   * Stored verbatim so that the verifier doesn't have to reproduce SQL-side
   * canonicalisation (in particular: pgvector's TEXT-format of the embedding,
   * which JS would round-trip differently). */
  profile_payload: Record<string, unknown>;
  birth_certificate: BirthCert | null;
}

export interface FederationBundle {
  v: 1;
  kind: "genome_bundle";
  exported_at: string;
  exported_by: { host: string; pubkey_hex?: string };
  root: GenomeNodeBundle;            // the genome we want to ship
  lineage: GenomeNodeBundle[];       // ancestors, root-of-tree first (oldest → newest)
  // Memories are out-of-scope for Phase 2; Phase 3 adds PoM-verified transfer.
  memories?: never;
}

export interface ImportVerdict {
  decision: "accepted" | "rejected" | "quarantined";
  reason: string;
  genome_label: string;
  genome_id: string;
  source_host: string;
  source_pubkey_hex: string | null;
  bundle_hash_hex: string;
  trust_root_pubkey_hex: string | null;  // which key authorized acceptance
  guard_verdicts: Record<string, unknown>;
  audit_id?: string;
}

// ---------------------------------------------------------------------------
// FederationService
// ---------------------------------------------------------------------------

export class FederationService {
  private db: PostgrestClient;
  private guard: GuardService;
  private localHostId: string;

  constructor(supabaseUrl: string, supabaseKey: string, guard: GuardService, localHostId: string = "self") {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
    this.guard = guard;
    this.localHostId = localHostId;
  }

  // -- export --------------------------------------------------------------
  async exportBundle(label: string, options: { destination?: string; exported_by?: string } = {}): Promise<{
    bundle: FederationBundle;
    bundle_hash_hex: string;
    bundle_size: number;
  }> {
    const root = await this._collectNode(label);
    if (!root) throw new Error(`genome ${label} not found`);
    const lineage: GenomeNodeBundle[] = [];
    const seen = new Set<string>([root.genome.id]);
    const queue = [...root.genome.parent_ids];
    while (queue.length) {
      const pid = queue.shift()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const node = await this._collectNodeById(pid);
      if (!node) continue;          // dangling parent reference — ship without
      lineage.unshift(node);        // ancestors-first
      for (const gp of node.genome.parent_ids) if (!seen.has(gp)) queue.push(gp);
    }
    const bundle: FederationBundle = {
      v: 1,
      kind: "genome_bundle",
      exported_at: new Date().toISOString(),
      exported_by: { host: this.localHostId },
      root,
      lineage,
    };
    const canonical = canonicalJson(bundle);
    const hash = sha256(canonical);
    const size = Buffer.byteLength(canonical, "utf8");

    await this.db.rpc("federation_log_export", {
      p_genome_label: label,
      p_genome_id: root.genome.id,
      p_destination: options.destination ?? null,
      p_bundle_hash: "\\x" + hash.toString("hex"),
      p_bundle_size: size,
      p_include_memories: false,
      p_exported_by: options.exported_by ?? null,
    });
    return { bundle, bundle_hash_hex: hash.toString("hex"), bundle_size: size };
  }

  private async _collectNode(label: string): Promise<GenomeNodeBundle | null> {
    const { data, error } = await this.db
      .from("agent_genomes")
      .select("*")
      .eq("label", label)
      .maybeSingle();
    if (error) throw new Error(`fetch ${label}: ${fmtErr(error)}`);
    if (!data) return null;
    const payloadRes = await this.db.rpc("genome_profile_payload", { p_label: label });
    if (payloadRes.error) throw new Error(`payload ${label}: ${fmtErr(payloadRes.error)}`);
    return this._toNode(data as Record<string, unknown>, payloadRes.data as Record<string, unknown>);
  }

  private async _collectNodeById(id: string): Promise<GenomeNodeBundle | null> {
    const { data, error } = await this.db
      .from("agent_genomes")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`fetch ${id}: ${fmtErr(error)}`);
    if (!data) return null;
    const label = (data as { label: string }).label;
    const payloadRes = await this.db.rpc("genome_profile_payload", { p_label: label });
    if (payloadRes.error) throw new Error(`payload ${label}: ${fmtErr(payloadRes.error)}`);
    return this._toNode(data as Record<string, unknown>, payloadRes.data as Record<string, unknown>);
  }

  private _toNode(g: Record<string, unknown>, profilePayload: Record<string, unknown>): GenomeNodeBundle {
    const emb = g.profile_embedding;
    const embArr: number[] | null = typeof emb === "string"
      ? JSON.parse(emb)
      : (Array.isArray(emb) ? (emb as number[]) : null);
    const pubkeyHex = bytesFieldToHex(g.pubkey);
    const profileSigHex = bytesFieldToHex(g.profile_signature);
    const merkleRootHex = bytesFieldToHex(g.memory_merkle_root);
    return {
      genome: {
        id:                    g.id as string,
        label:                 g.label as string,
        generation:            g.generation as number,
        parent_ids:           (g.parent_ids as string[]) ?? [],
        values:               (g.values as string[]) ?? [],
        interests:            (g.interests as string[]) ?? [],
        curiosity_baseline:    g.curiosity_baseline as number,
        frustration_threshold: g.frustration_threshold as number,
        exploration_rate:      g.exploration_rate as number,
        risk_tolerance:        g.risk_tolerance as number,
        mutation_rate:         g.mutation_rate as number,
        notes:                (g.notes as string) ?? null,
        pubkey_hex:            pubkeyHex ?? "",
        profile_signature_hex: profileSigHex ?? "",
        profile_embedding:     embArr,
        memory_merkle_root_hex: merkleRootHex,
        memory_merkle_n:      (g.memory_merkle_n as number) ?? null,
      },
      profile_payload: profilePayload,
      birth_certificate: (g.birth_certificate as BirthCert) ?? null,
    };
  }

  // -- import --------------------------------------------------------------
  async importBundle(bundle: FederationBundle, options: {
    imported_by?: string;
    /** When true, accept bundles without finding any trust-root match (DEBUG). */
    bypass_trust_root?: boolean;
    /** When true, skip guard.classify_content (testing only). */
    skip_guard?: boolean;
    /** Phase 3c: PoM-Callback. Wird aufgerufen zwischen Guard-OK und DB-Insert,
     *  nur wenn memory_merkle_n > 0. Rückgabe ok=false → decision=rejected. */
    pom_verify?: (ctx: { label: string; merkle_root_hex: string; merkle_n: number }) => Promise<{ ok: boolean; reason: string; proofs_verified?: number; proofs_total?: number }>;
  } = {}): Promise<ImportVerdict> {
    const canonical = canonicalJson(bundle);
    const bundleHash = sha256(canonical);
    const bundleHashHex = bundleHash.toString("hex");
    const sourceHost = bundle.exported_by?.host ?? "unknown";
    const sourcePubkeyHex = bundle.exported_by?.pubkey_hex ?? null;
    const rootGenome = bundle.root.genome;

    const verdict: ImportVerdict = {
      decision: "rejected",
      reason: "init",
      genome_label: rootGenome.label,
      genome_id: rootGenome.id,
      source_host: sourceHost,
      source_pubkey_hex: sourcePubkeyHex,
      bundle_hash_hex: bundleHashHex,
      trust_root_pubkey_hex: null,
      guard_verdicts: {},
    };

    try {
      // 0. Bundle-Schema-Sanity
      if (bundle.v !== 1 || bundle.kind !== "genome_bundle") {
        verdict.reason = `unknown bundle version/kind (v=${bundle.v} kind=${bundle.kind})`;
        return await this._logAndReturn(verdict, bundle, bundleHash);
      }

      // 1. Verify Lineage-Sig-Chain (deepest first → root)
      const allNodes = [...bundle.lineage, bundle.root];
      const chainResult = this._verifyChain(allNodes);
      if (!chainResult.ok) {
        verdict.reason = `chain verification failed: ${chainResult.reason}`;
        return await this._logAndReturn(verdict, bundle, bundleHash);
      }

      // 2. Revocation check on every key in chain
      for (const node of allNodes) {
        const pubHex = node.genome.pubkey_hex;
        if (!pubHex) continue;
        const rev = await this._checkRevocation(Buffer.from(pubHex, "hex"));
        if (rev) {
          verdict.reason = `revoked key in lineage (${node.genome.label}): ${rev.reason}`;
          return await this._logAndReturn(verdict, bundle, bundleHash);
        }
      }

      // 3. Find a trust root in the chain (or via source pubkey)
      let trustRootHex: string | null = null;
      for (const node of allNodes) {
        const pubHex = node.genome.pubkey_hex;
        if (!pubHex) continue;
        const tr = await this._checkTrust(Buffer.from(pubHex, "hex"));
        if (tr.trusted) { trustRootHex = pubHex; break; }
      }
      if (!trustRootHex && sourcePubkeyHex) {
        const tr = await this._checkTrust(Buffer.from(sourcePubkeyHex, "hex"));
        if (tr.trusted) trustRootHex = sourcePubkeyHex;
      }
      if (!trustRootHex && !options.bypass_trust_root) {
        verdict.reason = "no trust root found in lineage or source";
        return await this._logAndReturn(verdict, bundle, bundleHash);
      }
      verdict.trust_root_pubkey_hex = trustRootHex;

      // 4. Guard: classify_content on free-text fields of root
      let guardVerdicts: Record<string, unknown> = {};
      let quarantine = false;
      if (!options.skip_guard) {
        const fields: Array<[string, string]> = [
          ["notes",     rootGenome.notes ?? ""],
          ["interests", rootGenome.interests.join(", ")],
          ["values",    rootGenome.values.join(", ")],
        ];
        for (const [name, text] of fields) {
          if (!text.trim()) continue;
          try {
            const result = await this.guard.classify({ content: text, source: `federation:${sourceHost}:${name}` });
            guardVerdicts[name] = { verdict: result.verdict, action: result.action_hint };
            if (result.verdict === "malicious") {
              verdict.guard_verdicts = guardVerdicts;
              verdict.reason = `guard rejected ${name} as malicious`;
              return await this._logAndReturn(verdict, bundle, bundleHash);
            }
            if (result.verdict === "suspicious") quarantine = true;
          } catch (e) {
            guardVerdicts[name] = { verdict: "error", error: fmtErr(e) };
          }
        }
      }
      verdict.guard_verdicts = guardVerdicts;

      // 4b. PoM: wenn Memory-Merkle beansprucht wird UND ein Callback vorhanden,
      //     challenge den Exporter bevor wir das Genome final in die DB schreiben.
      const claimedRoot = rootGenome.memory_merkle_root_hex;
      const claimedN    = rootGenome.memory_merkle_n ?? 0;
      if (options.pom_verify && claimedRoot && claimedN > 0) {
        let pomResult;
        try {
          pomResult = await options.pom_verify({ label: rootGenome.label, merkle_root_hex: claimedRoot, merkle_n: claimedN });
        } catch (e) {
          verdict.reason = `PoM challenge error: ${fmtErr(e)}`;
          (verdict.guard_verdicts as Record<string, unknown>)._pom = { error: fmtErr(e) };
          return await this._logAndReturn(verdict, bundle, bundleHash);
        }
        (verdict.guard_verdicts as Record<string, unknown>)._pom = pomResult;
        if (!pomResult.ok) {
          verdict.reason = `PoM failed: ${pomResult.reason}`;
          return await this._logAndReturn(verdict, bundle, bundleHash);
        }
      }

      // 5. Insert root genome into agent_genomes (skip-or-conflict policy)
      const insertResult = await this._insertImportedGenome(bundle.root, sourceHost, quarantine);
      if (!insertResult.ok) {
        verdict.reason = insertResult.reason;
        return await this._logAndReturn(verdict, bundle, bundleHash);
      }

      verdict.decision = quarantine ? "quarantined" : "accepted";
      verdict.reason = quarantine
        ? "imported with quarantine status (guard flagged suspicious content)"
        : `accepted via trust root ${trustRootHex?.slice(0, 16) ?? "(bypassed)"}…`;
      return await this._logAndReturn(verdict, bundle, bundleHash);
    } catch (e) {
      verdict.reason = `unexpected error: ${fmtErr(e)}`;
      return await this._logAndReturn(verdict, bundle, bundleHash);
    }
  }

  private _verifyChain(nodes: GenomeNodeBundle[]): { ok: boolean; reason?: string } {
    for (const node of nodes) {
      const g = node.genome;
      if (!g.pubkey_hex) return { ok: false, reason: `${g.label}: no pubkey` };
      if (!g.profile_signature_hex) return { ok: false, reason: `${g.label}: no profile signature` };
      if (!node.profile_payload) return { ok: false, reason: `${g.label}: no profile_payload in bundle` };

      // Verify profile signature over the EXACT canonical bytes that were
      // signed (we ship the JSONB verbatim to avoid encoding skew).
      const pub = Buffer.from(g.pubkey_hex, "hex");
      const sig = Buffer.from(g.profile_signature_hex, "hex");
      const payload = canonicalJson(node.profile_payload);
      if (!verify(pub, Buffer.from(payload, "utf8"), sig)) {
        return { ok: false, reason: `${g.label}: profile signature does not match` };
      }
      // Cross-check: typed genome fields must agree with what was signed,
      // otherwise an attacker could swap fields while keeping the signed payload.
      const p = node.profile_payload as Record<string, unknown>;
      if (p.id !== g.id || p.label !== g.label || p.generation !== g.generation) {
        return { ok: false, reason: `${g.label}: typed fields differ from signed payload (id/label/generation)` };
      }
      const matchArr = (a: unknown, b: string[]): boolean => {
        if (!Array.isArray(a)) return false;
        const aSorted = [...(a as string[])].sort();
        const bSorted = [...b].sort();
        return aSorted.length === bSorted.length && aSorted.every((x, i) => x === bSorted[i]);
      };
      if (!matchArr(p.values, g.values))    return { ok: false, reason: `${g.label}: values differ from signed payload` };
      if (!matchArr(p.interests, g.interests)) return { ok: false, reason: `${g.label}: interests differ from signed payload` };
      const numFields: Array<[keyof typeof g, string]> = [
        ["curiosity_baseline", "curiosity_baseline"],
        ["frustration_threshold", "frustration_threshold"],
        ["exploration_rate", "exploration_rate"],
        ["risk_tolerance", "risk_tolerance"],
        ["mutation_rate", "mutation_rate"],
      ];
      for (const [k, sk] of numFields) {
        if ((p as Record<string, unknown>)[sk] !== (g as Record<string, unknown>)[k]) {
          return { ok: false, reason: `${g.label}: ${k} differs from signed payload` };
        }
      }

      // Birth-cert: if parents are present, both parent sigs must verify
      // against the parent pubkeys named inside the birth-cert payload.
      if (g.parent_ids.length > 0) {
        const bc = node.birth_certificate;
        if (!bc) return { ok: false, reason: `${g.label}: parents present but no birth_certificate` };
        const payloadBuf = buildBirthCertPayload(bc.payload);
        const pubA = Buffer.from(bc.payload.parent_a.pubkey_hex, "hex");
        const pubB = Buffer.from(bc.payload.parent_b.pubkey_hex, "hex");
        const sigA = Buffer.from(bc.parent_a_sig_hex, "hex");
        const sigB = Buffer.from(bc.parent_b_sig_hex, "hex");
        if (!verify(pubA, payloadBuf, sigA)) return { ok: false, reason: `${g.label}: parent_a sig invalid` };
        if (!verify(pubB, payloadBuf, sigB)) return { ok: false, reason: `${g.label}: parent_b sig invalid` };
        // Cross-check: child_pubkey in birth-cert must match this node's pubkey
        if (bc.payload.child_pubkey_hex !== g.pubkey_hex) {
          return { ok: false, reason: `${g.label}: birth-cert child_pubkey mismatch` };
        }
        if (bc.payload.child_id !== g.id) {
          return { ok: false, reason: `${g.label}: birth-cert child_id mismatch` };
        }
      }
    }
    return { ok: true };
  }

  private async _checkRevocation(pubkey: Buffer): Promise<{ reason: string } | null> {
    const { data, error } = await this.db
      .from("revoked_keys")
      .select("reason")
      .eq("pubkey", "\\x" + pubkey.toString("hex"))
      .maybeSingle();
    if (error) throw new Error(`revocation check: ${fmtErr(error)}`);
    return data ? { reason: (data as { reason: string }).reason } : null;
  }

  private async _checkTrust(pubkey: Buffer): Promise<{ trusted: boolean }> {
    const { data, error } = await this.db.rpc("trust_check", { p_pubkey: "\\x" + pubkey.toString("hex") });
    if (error) throw new Error(`trust check: ${fmtErr(error)}`);
    return data as { trusted: boolean };
  }

  private async _insertImportedGenome(
    node: GenomeNodeBundle,
    sourceHost: string,
    quarantine: boolean
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const g = node.genome;
    // Conflict checks
    const { data: existing } = await this.db
      .from("agent_genomes")
      .select("id, label, pubkey")
      .or(`id.eq.${g.id},label.eq.${g.label}`);
    const rows = (existing ?? []) as Array<{ id: string; label: string; pubkey: string | null }>;
    for (const r of rows) {
      if (r.id === g.id) {
        const localHex = bytesFieldToHex(r.pubkey);
        if (localHex && localHex !== g.pubkey_hex) {
          return { ok: false, reason: "id collision with different pubkey (impersonation attempt)" };
        }
        return { ok: false, reason: "genome already exists locally (idempotent skip)" };
      }
      if (r.label === g.label) {
        return { ok: false, reason: `label '${g.label}' already taken locally — rename before re-import` };
      }
    }
    const insertRow = {
      id: g.id,
      label: g.label,
      generation: g.generation,
      parent_ids: g.parent_ids,
      values: g.values,
      interests: g.interests,
      curiosity_baseline: g.curiosity_baseline,
      frustration_threshold: g.frustration_threshold,
      exploration_rate: g.exploration_rate,
      risk_tolerance: g.risk_tolerance,
      mutation_rate: g.mutation_rate,
      notes: g.notes,
      status: quarantine ? "paused" : "active",   // paused as quarantine marker
      pubkey: "\\x" + g.pubkey_hex,
      profile_signature: g.profile_signature_hex ? "\\x" + g.profile_signature_hex : null,
      profile_embedding: g.profile_embedding ? "[" + g.profile_embedding.join(",") + "]" : null,
      memory_merkle_root: g.memory_merkle_root_hex ? "\\x" + g.memory_merkle_root_hex : null,
      memory_merkle_n: g.memory_merkle_n,
      birth_certificate: node.birth_certificate as unknown,
      federated_from: sourceHost,
    };
    const { error } = await this.db.from("agent_genomes").insert(insertRow);
    if (error) return { ok: false, reason: `insert failed: ${fmtErr(error)}` };
    return { ok: true };
  }

  private async _logAndReturn(
    v: ImportVerdict,
    bundle: FederationBundle,
    bundleHash: Buffer
  ): Promise<ImportVerdict> {
    const { data } = await this.db.rpc("federation_log_import", {
      p_source_host:   v.source_host,
      p_source_pubkey: v.source_pubkey_hex ? "\\x" + v.source_pubkey_hex : null,
      p_bundle_hash:   "\\x" + bundleHash.toString("hex"),
      p_bundle:        bundle as unknown as Record<string, unknown>,
      p_genome_label:  v.genome_label,
      p_genome_id:     v.genome_id,
      p_decision:      v.decision,
      p_reason:        v.reason,
      p_guard_verdicts: v.guard_verdicts,
      p_imported_by:   null,
    });
    v.audit_id = (data as string | null) ?? undefined;
    return v;
  }

  // -- trust-list passthroughs ---------------------------------------------
  async trustAdd(input: { kind: "host" | "genome" | "group"; identifier: string; pubkey_hex: string; label?: string; notes?: string; added_by?: string }) {
    const { data, error } = await this.db.rpc("trust_add", {
      p_kind: input.kind, p_identifier: input.identifier,
      p_pubkey: "\\x" + input.pubkey_hex,
      p_label: input.label ?? null, p_notes: input.notes ?? null,
      p_added_by: input.added_by ?? null,
    });
    if (error) throw new Error(`trust_add: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  async trustList(includeRevoked = false): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.db.rpc("trust_list", { p_include_revoked: includeRevoked });
    if (error) throw new Error(`trust_list: ${fmtErr(error)}`);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async trustRevoke(input: { pubkey_hex: string; reason: string; revoked_by?: string }) {
    const { data, error } = await this.db.rpc("trust_revoke", {
      p_pubkey: "\\x" + input.pubkey_hex,
      p_reason: input.reason,
      p_revoked_by: input.revoked_by ?? null,
      p_evidence: {},
    });
    if (error) throw new Error(`trust_revoke: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  async federationRecent(limit = 25): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.db.rpc("federation_recent", { p_limit: limit });
    if (error) throw new Error(`federation_recent: ${fmtErr(error)}`);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  // ---- peer directory (Phase 3f, Migration 041) -----------------------
  async peerUpsert(input: {
    pubkey_hex: string;
    label?: string;
    outbound_host?: string;
    outbound_port?: number;
    auto_sync_enabled?: boolean;
  }): Promise<Record<string, unknown>> {
    const { data, error } = await this.db.rpc("peer_upsert", {
      p_pubkey:            "\\x" + input.pubkey_hex,
      p_label:             input.label ?? null,
      p_outbound_host:     input.outbound_host ?? null,
      p_outbound_port:     input.outbound_port ?? null,
      p_auto_sync_enabled: input.auto_sync_enabled ?? null,
    });
    if (error) throw new Error(`peer_upsert: ${fmtErr(error)}`);
    return data as Record<string, unknown>;
  }

  async peersList(only_autosync = false): Promise<Array<Record<string, unknown>>> {
    const { data, error } = await this.db.rpc("peers_list", { p_only_autosync: only_autosync });
    if (error) throw new Error(`peers_list: ${fmtErr(error)}`);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  async peerRecordSync(pubkey_hex: string, ok: boolean, note?: string): Promise<void> {
    const { error } = await this.db.rpc("peer_record_sync", {
      p_pubkey: "\\x" + pubkey_hex,
      p_ok:     ok,
      p_note:   note ?? null,
    });
    if (error) throw new Error(`peer_record_sync: ${fmtErr(error)}`);
  }

  async federationAuditCleanup(older_than_days = 90): Promise<{ imports_deleted: number; exports_deleted: number }> {
    const { data, error } = await this.db.rpc("federation_audit_cleanup", { p_older_than_days: older_than_days });
    if (error) throw new Error(`federation_audit_cleanup: ${fmtErr(error)}`);
    return data as { imports_deleted: number; exports_deleted: number };
  }

  // ---- Phase 3b: HTTPS/mTLS client (pull + push) -------------------------
  //
  // Uses the local host cert+key to authenticate against the peer. Peer's
  // self-signed server cert is trusted via trust_roots.kind='host' lookup
  // AFTER handshake (we set rejectUnauthorized=false and verify ourselves).

  private _httpsAgentCreds(): { cert: Buffer; key: Buffer } {
    const dir = process.env.OPENCLAW_KEYS_DIR ?? join(homedir(), ".openclaw", "keys");
    return {
      cert: readFileSync(join(dir, "host.crt")),
      key:  readFileSync(join(dir, "host.key")),
    };
  }

  private _mtlsRequest(host: string, port: number, path: string, method: "GET" | "POST", body?: string, extraHeaders?: Record<string, string>): Promise<{
    status: number; body: string; peerCert: Buffer | null;
  }> {
    const creds = this._httpsAgentCreds();
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }
      const req = httpsRequest({
        host, port, path, method,
        cert: creds.cert,
        key:  creds.key,
        rejectUnauthorized: false,  // we verify server cert ourselves
        headers,
      }, (res) => {
        // Peer cert is reachable via req.socket once the response headers arrive.
        const sock = (req.socket ?? res.socket) as unknown as { getPeerCertificate?: (d: boolean) => { raw?: Buffer } };
        const peerCert = sock?.getPeerCertificate?.(true)?.raw ?? null;
        let buf = "";
        res.on("data", (c) => buf += c);
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf, peerCert }));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }

  /** Verifies the peer's server cert pubkey against trust_roots. Throws if not trusted. */
  private async _verifyPeerCert(peerCertDer: Buffer | null, expectedHost: string): Promise<void> {
    if (!peerCertDer) throw new Error(`no peer cert received from ${expectedHost}`);
    // Import crypto.X509Certificate via node:crypto — same approach as host
    const { X509Certificate } = await import("node:crypto");
    const cert = new X509Certificate(peerCertDer);
    const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const pub = spki.subarray(spki.length - 32);
    const check = await this._checkTrust(pub);
    if (!check.trusted) {
      throw new Error(`peer server cert pubkey ${pub.toString("hex").slice(0, 16)}… is not a trusted host`);
    }
  }

  /** Pull a bundle from a peer, then import it locally (with PoM verification). */
  async pull(input: { host: string; port: number; label: string; pom_k?: number }): Promise<ImportVerdict> {
    const r = await this._mtlsRequest(input.host, input.port, `/federation/export/${encodeURIComponent(input.label)}`, "GET");
    if (r.status !== 200) throw new Error(`peer export failed: HTTP ${r.status} — ${r.body.slice(0, 200)}`);
    await this._verifyPeerCert(r.peerCert, input.host);
    const parsed = JSON.parse(r.body) as { bundle: FederationBundle };

    const pom_verify = async (ctx: { label: string; merkle_root_hex: string; merkle_n: number }) => {
      return this._runPomChallenge({
        host: input.host, port: input.port,
        label: ctx.label,
        claimed_root_hex: ctx.merkle_root_hex,
        n: ctx.merkle_n,
        k: input.pom_k ?? 5,
      });
    };

    return this.importBundle(parsed.bundle, {
      imported_by: `pull:${input.host}:${input.port}`,
      pom_verify,
    });
  }

  /** Server-driven PoM: importer picks K random indices, peer responds with
   *  Merkle-inclusion-proofs, importer verifies each against the claimed root.
   *  Public so the dashboard-server can call it for push-flow reverse-challenges. */
  async challengePom(input: {
    host: string; port: number;
    label: string;
    claimed_root_hex: string;
    n: number;
    k: number;
    /** Optional: after TLS, assert the peer cert pubkey equals this hex.
     *  Used to bind a reverse-callback to the identity of the original pusher. */
    expected_pubkey_hex?: string;
  }): Promise<{ ok: boolean; reason: string; proofs_verified?: number; proofs_total?: number }> {
    return this._runPomChallenge(input);
  }

  private async _runPomChallenge(input: {
    host: string; port: number;
    label: string;
    claimed_root_hex: string;
    n: number;
    k: number;
    expected_pubkey_hex?: string;
  }): Promise<{ ok: boolean; reason: string; proofs_verified?: number; proofs_total?: number }> {
    const k = Math.min(input.k, input.n);
    // Unique random indices in [0, n)
    const all = new Set<number>();
    while (all.size < k) all.add(Math.floor(Math.random() * input.n));
    const indices = [...all].sort((a, b) => a - b);
    const resp = await this._mtlsRequest(
      input.host, input.port, "/pom/proof", "POST",
      JSON.stringify({ label: input.label, indices })
    );
    if (resp.status !== 200) {
      return { ok: false, reason: `PoM HTTP ${resp.status}: ${resp.body.slice(0, 160)}` };
    }
    // First: the peer's server cert must be a trusted host.
    try {
      await this._verifyPeerCert(resp.peerCert, input.host);
    } catch (e) {
      return { ok: false, reason: `peer cert not trusted: ${e instanceof Error ? e.message : String(e)}` };
    }
    // Second: when we expect a specific pubkey (push-flow callback binding),
    // the peer's cert pubkey MUST equal that expected value — otherwise an
    // attacker could redirect us to a different trusted host's /pom/proof
    // that claims the same merkle root (collision attack).
    if (input.expected_pubkey_hex && resp.peerCert) {
      const { X509Certificate } = await import("node:crypto");
      const cert = new X509Certificate(resp.peerCert);
      const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const actual = spki.subarray(spki.length - 32).toString("hex").toLowerCase();
      const expected = input.expected_pubkey_hex.toLowerCase();
      if (actual !== expected) {
        return {
          ok: false,
          reason: `callback cert pubkey mismatch: expected ${expected.slice(0, 16)}…, got ${actual.slice(0, 16)}…`,
        };
      }
    }
    let parsed: {
      merkle_root_hex: string;
      merkle_n: number;
      proofs: Array<{ index: number; memory_id: string; leaf_hex: string; siblings_hex: string[] }>;
    };
    try { parsed = JSON.parse(resp.body); } catch { return { ok: false, reason: "PoM response is not JSON" }; }

    // Staleness / swap check: the peer's CURRENT Merkle-root must match the
    // root the Exporter put in the bundle. If the peer has re-built memories
    // since export, it should have refreshed its root before shipping.
    if (parsed.merkle_root_hex !== input.claimed_root_hex) {
      return {
        ok: false,
        reason: `peer's current root (${parsed.merkle_root_hex.slice(0, 16)}…) differs from bundle root (${input.claimed_root_hex.slice(0, 16)}…)`,
      };
    }
    if (parsed.merkle_n !== input.n) {
      return { ok: false, reason: `peer's n=${parsed.merkle_n} differs from bundle n=${input.n}` };
    }
    const rootBuf = Buffer.from(input.claimed_root_hex, "hex");
    let verified = 0;
    for (const p of parsed.proofs) {
      const leaf: Buffer = Buffer.from(p.leaf_hex, "hex");
      const siblings: Buffer[] = p.siblings_hex.map((h) => Buffer.from(h, "hex"));
      let h: Buffer = leaf;
      let idx = p.index;
      for (const sib of siblings) {
        const pair: Buffer = idx % 2 === 0 ? Buffer.concat([h, sib]) : Buffer.concat([sib, h]);
        h = sha256(pair);
        idx = Math.floor(idx / 2);
      }
      if (h.equals(rootBuf)) verified++;
    }
    const ok = verified === parsed.proofs.length && verified === indices.length;
    return {
      ok,
      reason: ok
        ? `${verified}/${indices.length} Merkle inclusion proofs valid`
        : `only ${verified}/${indices.length} proofs valid`,
      proofs_verified: verified,
      proofs_total: indices.length,
    };
  }

  /** Pull a peer's signed revocation list, verify each, and merge into ours. */
  async syncRevocations(input: { host: string; port: number }): Promise<{
    fetched: number;
    accepted: number;
    rejected_bad_sig: number;
    rejected_no_authority: number;
    rejected_malformed: number;
    skipped_already_known: number;
    details: Array<{ revoked_pubkey_hex: string; decision: string; reason?: string }>;
  }> {
    const r = await this._mtlsRequest(input.host, input.port, "/federation/revocations", "GET");
    if (r.status !== 200) throw new Error(`peer revocations failed: HTTP ${r.status} — ${r.body.slice(0, 200)}`);
    await this._verifyPeerCert(r.peerCert, input.host);
    const body = JSON.parse(r.body) as { revocations: Array<Record<string, unknown>> };
    const revs = body.revocations ?? [];
    const result = {
      fetched: revs.length,
      accepted: 0,
      rejected_bad_sig: 0,
      rejected_no_authority: 0,
      rejected_malformed: 0,
      skipped_already_known: 0,
      details: [] as Array<{ revoked_pubkey_hex: string; decision: string; reason?: string }>,
    };
    const syncSource = `peer:${input.host}:${input.port}`;

    for (const rev of revs) {
      const revokedHex = String(rev.revoked_pubkey_hex ?? "");
      const signerHex  = String(rev.signer_pubkey_hex ?? "");
      const sigHex     = String(rev.signature_hex ?? "");
      const signedPayload = rev.signed_payload as RevocationPayload | null;
      const reason     = String(rev.reason ?? "");

      // 1. Malformed check
      if (!/^[0-9a-f]{64}$/.test(revokedHex) || !/^[0-9a-f]{64}$/.test(signerHex)
          || !/^[0-9a-f]{128}$/.test(sigHex) || !signedPayload) {
        result.rejected_malformed++;
        result.details.push({ revoked_pubkey_hex: revokedHex, decision: "rejected_malformed" });
        continue;
      }
      // 2. Internal consistency: signed_payload fields must match outer
      if (signedPayload.revoked_pubkey_hex?.toLowerCase() !== revokedHex
          || signedPayload.signer_pubkey_hex?.toLowerCase() !== signerHex) {
        result.rejected_malformed++;
        result.details.push({ revoked_pubkey_hex: revokedHex, decision: "rejected_payload_mismatch" });
        continue;
      }
      // 3. Signature verify
      const pub = Buffer.from(signerHex, "hex");
      const sig = Buffer.from(sigHex, "hex");
      const buf = buildRevocationPayload(signedPayload);
      if (!verify(pub, buf, sig)) {
        result.rejected_bad_sig++;
        result.details.push({ revoked_pubkey_hex: revokedHex, decision: "rejected_bad_sig" });
        continue;
      }
      // 4. Authority: self-revoke OR signer is local trust-root (genome/group)
      const isSelfRevoke = signerHex === revokedHex;
      let authorised = isSelfRevoke;
      if (!authorised) {
        const tc = await this._checkTrust(Buffer.from(signerHex, "hex"));
        authorised = (tc as unknown as { trusted: boolean; kind?: string }).trusted
          && ["genome", "group"].includes((tc as unknown as { kind?: string }).kind ?? "");
      }
      if (!authorised) {
        result.rejected_no_authority++;
        result.details.push({
          revoked_pubkey_hex: revokedHex,
          decision: "rejected_no_authority",
          reason: `signer ${signerHex.slice(0, 16)}… not authorised to revoke ${revokedHex.slice(0, 16)}…`,
        });
        continue;
      }
      // 5. Already have this exact signature?
      const { data: existing } = await this.db
        .from("revoked_keys")
        .select("signature")
        .eq("pubkey", "\\x" + revokedHex)
        .maybeSingle();
      const existingSig = (existing as { signature: string | null } | null)?.signature ?? null;
      const normalisedExisting = existingSig
        ? (existingSig.startsWith("\\x") ? existingSig.slice(2).toLowerCase() : existingSig.toLowerCase())
        : null;
      if (normalisedExisting && normalisedExisting === sigHex) {
        result.skipped_already_known++;
        continue;
      }
      // 6. Upsert
      const { error } = await this.db.rpc("revocation_upsert_signed", {
        p_revoked_pubkey: "\\x" + revokedHex,
        p_signer_pubkey:  "\\x" + signerHex,
        p_signature:      "\\x" + sigHex,
        p_signed_payload: signedPayload,
        p_reason:         reason,
        p_revoked_by:     `sync:${input.host}`,
        p_sync_source:    syncSource,
      });
      if (error) {
        result.rejected_malformed++;
        result.details.push({ revoked_pubkey_hex: revokedHex, decision: "upsert_error", reason: fmtErr(error) });
        continue;
      }
      result.accepted++;
      result.details.push({ revoked_pubkey_hex: revokedHex, decision: "accepted" });
    }
    return result;
  }

  /** Export a local bundle and push it to a peer's /federation/import.
   *  If OPENCLAW_FEDERATION_CALLBACK is set (e.g. "192.0.2.1:8788"), the
   *  pusher advertises that address via X-Federation-Callback header so the
   *  receiver can reverse-challenge for PoM. */
  async push(input: { host: string; port: number; label: string; callback?: string }): Promise<{ peer_status: number; peer_verdict: unknown; callback_advertised: string | null }> {
    const exp = await this.exportBundle(input.label, { destination: `${input.host}:${input.port}`, exported_by: "push" });
    const callback = input.callback ?? process.env.OPENCLAW_FEDERATION_CALLBACK ?? null;
    const headers = callback ? { "X-Federation-Callback": callback } : undefined;
    const r = await this._mtlsRequest(input.host, input.port, "/federation/import", "POST", JSON.stringify({ bundle: exp.bundle }), headers);
    await this._verifyPeerCert(r.peerCert, input.host);
    let verdict: unknown;
    try { verdict = JSON.parse(r.body); } catch { verdict = { raw: r.body }; }
    return { peer_status: r.status, peer_verdict: verdict, callback_advertised: callback };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** PostgREST returns BYTEA columns as either "\xDEAD…" string or a base64 string
 * depending on settings. Normalise to lowercase hex without prefix. */
function bytesFieldToHex(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    if (v.startsWith("\\x")) return v.slice(2).toLowerCase();
    // assume hex already, or base64 — try hex first
    if (/^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
    try { return Buffer.from(v, "base64").toString("hex"); } catch { return v; }
  }
  if (Buffer.isBuffer(v)) return v.toString("hex");
  return null;
}
