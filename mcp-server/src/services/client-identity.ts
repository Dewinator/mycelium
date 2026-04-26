/**
 * Per-client agent-label derivation.
 *
 * The MCP `initialize` handshake gives us `clientInfo.name` (e.g. "claude-code",
 * "openclaw", "cursor", "codex"). We turn that into a deterministic
 * agent-label that is stable per (client × host × process) so multiple parallel
 * sessions of the same client get distinct registry rows without colliding.
 *
 * The label is also written to `agents.label`, which is UNIQUE — uniqueness is
 * the load-bearing property here.
 */

export interface ClientInfo {
  name?: string;
  version?: string;
}

const MAX_LABEL_LEN = 60;

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortHost(host: string): string {
  // hostname can be "Mac-mini-von-Reed.local" — shorten to first segment
  return sanitize(host.split(".")[0] ?? host).slice(0, 20);
}

/**
 * Build a per-session agent label.
 *
 * Examples:
 *   { name: "claude-code", version: "1.2.3" }, "Mac-mini-von-Reed.local", 51188
 *     → "claude-code-mac-mini-von-reed-51188"
 *
 * If clientInfo.name is missing/empty, uses "unknown-client".
 */
export function deriveClientLabel(
  clientInfo: ClientInfo | undefined,
  host: string,
  pid: number,
): string {
  const rawName = clientInfo?.name?.trim() || "unknown-client";
  const name = sanitize(rawName) || "unknown-client";
  const hostPart = shortHost(host);
  const candidate = `${name}-${hostPart}-${pid}`;
  if (candidate.length <= MAX_LABEL_LEN) return candidate;
  // truncate name first, keep host+pid suffix readable
  const suffix = `-${hostPart}-${pid}`;
  const room = Math.max(1, MAX_LABEL_LEN - suffix.length);
  return name.slice(0, room) + suffix;
}
