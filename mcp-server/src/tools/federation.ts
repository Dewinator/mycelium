import { z } from "zod";
import type { FederationService, FederationBundle } from "../services/federation.js";

// ---------------------------------------------------------------------------
// trust list management
// ---------------------------------------------------------------------------

export const trustAddSchema = z.object({
  kind: z.enum(["host", "genome", "group"]).describe("What kind of identity to trust"),
  identifier: z.string().describe("Human identifier (e.g. 'mac-mini-m4', 'enrico-main', 'phasex-team')"),
  pubkey_hex: z.string().regex(/^[0-9a-fA-F]{64}$/).describe("Ed25519 raw pubkey in hex (32 bytes)"),
  label: z.string().optional(),
  notes: z.string().optional(),
  added_by: z.string().optional(),
});

export async function trustAdd(svc: FederationService, input: z.infer<typeof trustAddSchema>) {
  const r = await svc.trustAdd(input);
  return { content: [{ type: "text" as const, text: `Added trust root [${input.kind}] ${input.identifier} pub=${input.pubkey_hex.slice(0, 16)}…` }] };
}

export const trustListSchema = z.object({
  include_revoked: z.boolean().optional().default(false),
});

export async function trustList(svc: FederationService, input: z.infer<typeof trustListSchema>) {
  const rows = await svc.trustList(input.include_revoked);
  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: "No trust roots configured." }] };
  }
  const lines = rows.map((r) =>
    `[${r.status}] ${r.kind}/${r.identifier}` +
    (r.label ? ` (${r.label})` : "") +
    `\n   pubkey: ${(r.pubkey_hex as string).slice(0, 24)}…  added=${(r.added_at as string).slice(0, 19)}`
  );
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const trustRevokeSchema = z.object({
  pubkey_hex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  reason: z.string().min(5),
  revoked_by: z.string().optional(),
});

export async function trustRevoke(svc: FederationService, input: z.infer<typeof trustRevokeSchema>) {
  const r = await svc.trustRevoke(input);
  return { content: [{ type: "text" as const, text: `Revoked ${input.pubkey_hex.slice(0, 16)}… — ${input.reason}` }] };
}

// ---------------------------------------------------------------------------
// export / import
// ---------------------------------------------------------------------------

export const federationExportSchema = z.object({
  label: z.string().describe("Genome label to export"),
  destination: z.string().optional().describe("Where this bundle is going (audit hint, e.g. 'mac-mini-m4', 'enrico-laptop')"),
  exported_by: z.string().optional(),
  /** When true, returns the raw JSON bundle as the tool output (large). Otherwise returns a summary + bundle hash. */
  return_bundle: z.boolean().optional().default(true),
});

export async function federationExport(svc: FederationService, input: z.infer<typeof federationExportSchema>) {
  const r = await svc.exportBundle(input.label, { destination: input.destination, exported_by: input.exported_by });
  const summary = [
    `Exported '${input.label}'`,
    `  bundle hash: ${r.bundle_hash_hex}`,
    `  size:        ${r.bundle_size} bytes`,
    `  lineage:     ${r.bundle.lineage.length} ancestors`,
    `  destination: ${input.destination ?? "(unspecified)"}`,
  ].join("\n");
  if (!input.return_bundle) {
    return { content: [{ type: "text" as const, text: summary }] };
  }
  // Return summary + bundle JSON; consumer (CLI / dashboard) can pipe to file.
  return {
    content: [
      { type: "text" as const, text: summary + "\n\n--- BUNDLE JSON ---\n" + JSON.stringify(r.bundle, null, 2) },
    ],
  };
}

export const federationImportSchema = z.object({
  bundle_json: z.string().describe("The full bundle as a JSON string"),
  imported_by: z.string().optional(),
  bypass_trust_root: z.boolean().optional().default(false).describe("DEBUG ONLY: accept bundles even without a trust-root match. Logged in audit."),
  skip_guard: z.boolean().optional().default(false).describe("DEBUG ONLY: skip classify_content. Logged in audit."),
});

export async function federationImport(svc: FederationService, input: z.infer<typeof federationImportSchema>) {
  let bundle: FederationBundle;
  try {
    bundle = JSON.parse(input.bundle_json) as FederationBundle;
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Bundle JSON parse failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
  const v = await svc.importBundle(bundle, {
    imported_by: input.imported_by,
    bypass_trust_root: input.bypass_trust_root,
    skip_guard: input.skip_guard,
  });
  const lines = [
    `Import verdict: ${v.decision.toUpperCase()}`,
    `  genome:      ${v.genome_label} (${v.genome_id.slice(0, 8)})`,
    `  source:      ${v.source_host}`,
    `  trust root:  ${v.trust_root_pubkey_hex ? v.trust_root_pubkey_hex.slice(0, 24) + "…" : "(none / bypassed)"}`,
    `  bundle hash: ${v.bundle_hash_hex.slice(0, 24)}…`,
    `  reason:      ${v.reason}`,
  ];
  if (Object.keys(v.guard_verdicts).length > 0) {
    lines.push("  guard:");
    for (const [field, verdict] of Object.entries(v.guard_verdicts)) {
      lines.push(`    ${field}: ${JSON.stringify(verdict)}`);
    }
  }
  return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: v.decision === "rejected" };
}

// ---------------------------------------------------------------------------
// network: pull / push (Phase 3b)
// ---------------------------------------------------------------------------

export const federationPullSchema = z.object({
  host: z.string().describe("Peer host (IP or hostname)"),
  port: z.number().int().min(1).max(65535).optional().default(8788),
  label: z.string().describe("Genome label to fetch from the peer"),
});

export async function federationPull(svc: FederationService, input: z.infer<typeof federationPullSchema>) {
  try {
    const v = await svc.pull(input);
    const lines = [
      `Pulled '${input.label}' from ${input.host}:${input.port}`,
      `  decision:   ${v.decision}`,
      `  reason:     ${v.reason}`,
      `  genome_id:  ${v.genome_id.slice(0, 8)}`,
      `  trust_root: ${v.trust_root_pubkey_hex ? v.trust_root_pubkey_hex.slice(0, 24) + "…" : "(none)"}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: v.decision === "rejected" };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `pull failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

export const federationPushSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).optional().default(8788),
  label: z.string().describe("Genome label to export and push"),
  callback: z.string().optional().describe("host:port the receiver can reverse-call for PoM. Defaults to OPENCLAW_FEDERATION_CALLBACK env."),
});

export async function federationPush(svc: FederationService, input: z.infer<typeof federationPushSchema>) {
  try {
    const r = await svc.push(input);
    const verdict = r.peer_verdict as { decision?: string; reason?: string };
    const lines = [
      `Pushed '${input.label}' to ${input.host}:${input.port}`,
      `  callback adv: ${r.callback_advertised ?? "(none)"}`,
      `  peer status:  HTTP ${r.peer_status}`,
      `  peer decision: ${verdict?.decision ?? "(unknown)"}`,
      `  peer reason:   ${verdict?.reason ?? "(unknown)"}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: r.peer_status >= 400 };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `push failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

// ---------------------------------------------------------------------------
// peer directory (Phase 3f)
// ---------------------------------------------------------------------------

export const peerUpsertSchema = z.object({
  pubkey_hex: z.string().regex(/^[0-9a-fA-F]{64}$/),
  label: z.string().optional(),
  outbound_host: z.string().optional(),
  outbound_port: z.number().int().min(1).max(65535).optional(),
  auto_sync_enabled: z.boolean().optional(),
});

export async function peerUpsert(svc: FederationService, input: z.infer<typeof peerUpsertSchema>) {
  const r = await svc.peerUpsert(input);
  const lines = [
    `Peer upserted:`,
    `  pubkey:            ${input.pubkey_hex.slice(0, 32)}…`,
    `  label:             ${r.label ?? "—"}`,
    `  outbound:          ${r.outbound_host ?? "—"}:${r.outbound_port ?? "—"}`,
    `  auto_sync:         ${r.auto_sync_enabled}`,
    `  trust_status:      ${r.trust_status}`,
  ];
  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
}

export const peersListSchema = z.object({
  only_autosync: z.boolean().optional().default(false),
});

export async function peersList(svc: FederationService, input: z.infer<typeof peersListSchema>) {
  const rows = await svc.peersList(input.only_autosync);
  if (rows.length === 0) return { content: [{ type: "text" as const, text: "No peers." }] };
  const lines = rows.map((p) =>
    `[${p.trust_status}] ${p.label ?? "(no label)"} ${p.outbound_host ?? "?"}:${p.outbound_port ?? "?"} ` +
    `auto=${p.auto_sync_enabled} errors=${p.sync_errors}\n   pubkey=${(p.pubkey_hex as string).slice(0, 24)}…` +
    (p.last_auto_sync_at ? `\n   last_sync=${(p.last_auto_sync_at as string).slice(0, 19)} ok=${p.last_auto_sync_ok}` : "")
  );
  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
}

export const federationSyncRevocationsSchema = z.object({
  host: z.string(),
  port: z.number().int().min(1).max(65535).optional().default(8788),
});

export async function federationSyncRevocations(
  svc: FederationService,
  input: z.infer<typeof federationSyncRevocationsSchema>
) {
  try {
    const r = await svc.syncRevocations(input);
    const lines = [
      `Revocation sync from ${input.host}:${input.port}`,
      `  fetched:              ${r.fetched}`,
      `  accepted:             ${r.accepted}`,
      `  skipped (known):      ${r.skipped_already_known}`,
      `  rejected (bad sig):   ${r.rejected_bad_sig}`,
      `  rejected (no auth):   ${r.rejected_no_authority}`,
      `  rejected (malformed): ${r.rejected_malformed}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `sync failed: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

export const federationRecentSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export async function federationRecent(svc: FederationService, input: z.infer<typeof federationRecentSchema>) {
  const rows = await svc.federationRecent(input.limit);
  if (rows.length === 0) {
    return { content: [{ type: "text" as const, text: "No federation imports recorded." }] };
  }
  const lines = rows.map((r) =>
    `[${(r.imported_at as string).slice(0, 19)}] ${r.decision} ${r.genome_label} ← ${r.source_host}\n   ${r.reason}`
  );
  return { content: [{ type: "text" as const, text: lines.join("\n\n") }] };
}
