/**
 * MCP tool `swarm_list_peers` — issue #143 (read-only slice).
 *
 * Lists every peer the local node has ever spoken to (plus optionally
 * the self row), enriched with trust state, quarantine status, last
 * trust-edge delta and a 24h admission count.
 *
 * Read-only — no env-flag gate. Write tools from the rest of #143
 * (swarm_publish_tier_a_lesson, swarm_admit_lesson, …) live in
 * separate files behind OPENCLAW_ALLOW_SWARM_WRITE=1.
 */
import { z } from "zod";
import type { SwarmPeersClient, PeerSummary } from "../services/swarm-peers.js";

export const swarmListPeersSchema = z.object({
  includeSelf: z
    .boolean()
    .optional()
    .describe(
      "If true, include the local self row in the result. Default false — operators usually want to see peers, not themselves."
    ),
});

function formatPeer(p: PeerSummary): string {
  const lines: string[] = [];
  lines.push(`${p.node_id}${p.is_self ? "  (self)" : ""}`);
  lines.push(`  display_name:           ${p.display_name ?? "(unset)"}`);
  lines.push(`  trust_weight:           ${p.trust_weight.toFixed(3)}`);
  lines.push(
    `  quarantined:            ${
      p.is_quarantined
        ? `yes (until ${p.quarantined_until})`
        : p.quarantined_until
          ? `no (last quarantine expired ${p.quarantined_until})`
          : "no"
    }`
  );
  lines.push(`  consecutive_rejections: ${p.consecutive_rejections}`);
  lines.push(`  last_seen_at:           ${p.last_seen_at ?? "(never)"}`);
  lines.push(
    `  last_decay_at:          ${p.last_decay_at ?? "(never)"}${
      p.decay_reason ? `  reason=${p.decay_reason}` : ""
    }`
  );
  if (p.last_trust_delta) {
    const d = p.last_trust_delta;
    lines.push(
      `  last_trust_delta:       ${d.weight_before.toFixed(3)} → ${d.weight_after.toFixed(3)}  (${d.reason}, ${d.at})`
    );
  } else {
    lines.push(`  last_trust_delta:       (none)`);
  }
  lines.push(`  admissions_24h:         ${p.recent_admissions_24h}`);
  return lines.join("\n");
}

export async function swarmListPeers(
  service: SwarmPeersClient,
  input: z.infer<typeof swarmListPeersSchema>
) {
  const peers = await service.listPeers(input.includeSelf ?? false);
  if (peers.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            "No peers known yet. Either the swarm bootstrap hasn't admitted any peers, " +
            "or includeSelf was false and only the self row exists.",
        },
      ],
    };
  }
  const header = `Found ${peers.length} peer${peers.length === 1 ? "" : "s"}:`;
  return {
    content: [
      {
        type: "text" as const,
        text: [header, "", ...peers.map(formatPeer)].join("\n\n"),
      },
    ],
  };
}
