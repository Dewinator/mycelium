/**
 * Agent-Registry-Client fuer den MCP-Server.
 *
 * Beim Start registriert sich der Server in der `agents`-Tabelle (agent_register),
 * pingt dann alle 30s agent_heartbeat und deregistriert sich beim SIGTERM.
 *
 * Das ist RUNTIME-Metadaten — Modellwahl etc. bleibt OpenClaw-seitig. Wir
 * reflektieren hier nur, was uns aus env/config vorgegeben wurde.
 */
import { PostgrestClient } from "@supabase/postgrest-js";
import os from "node:os";

function fmtErr(err: unknown): string {
  if (!err) return "unknown error";
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; details?: string; hint?: string; code?: string };
  return e.message || e.details || e.hint || e.code || JSON.stringify(err);
}

export type AgentKind = "server" | "client-session";

export interface RegistryConfig {
  /** Label of this running instance — e.g. "main", "dev-agent", "claude-code-mac-12345". */
  label: string;
  /** Label of the genome this instance runs. Defaults to same as instance label. */
  genomeLabel: string;
  /** Path to the OpenClaw workspace of this instance. */
  workspacePath: string;
  /** Optional override for host (defaults to os.hostname()). */
  host?: string;
  /** Optional MCP-server version string. */
  version?: string;
  /** Optional gateway URL (ws:// or http://). */
  gatewayUrl?: string;
  /** Port map as-is. */
  ports?: Record<string, number | string>;
  /** Capability tags ("vision", "cockpit", …). */
  capabilities?: string[];
  /** Extra metadata to persist on agents.metadata. */
  metadata?: Record<string, unknown>;
  /** Heartbeat interval in ms (default 30s). */
  heartbeatMs?: number;
  /** Registry row kind — "server" for backend processes, "client-session" for MCP clients. */
  kind?: AgentKind;
}

export class RegistryService {
  private db: PostgrestClient;
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(
    supabaseUrl: string,
    supabaseKey: string,
    public readonly cfg: RegistryConfig
  ) {
    this.db = new PostgrestClient(supabaseUrl, {
      headers: supabaseKey
        ? { Authorization: `Bearer ${supabaseKey}`, apikey: supabaseKey }
        : {},
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    const { error } = await this.db.rpc("agent_register", {
      p_label:          this.cfg.label,
      p_genome_label:   this.cfg.genomeLabel,
      p_workspace_path: this.cfg.workspacePath,
      p_host:           this.cfg.host ?? os.hostname(),
      p_version:        this.cfg.version ?? null,
      p_gateway_url:    this.cfg.gatewayUrl ?? null,
      p_ports:          this.cfg.ports ?? {},
      p_capabilities:   this.cfg.capabilities ?? [],
      p_metadata:       this.cfg.metadata ?? {},
      p_kind:           this.cfg.kind ?? "server",
    });
    if (error) {
      console.error(`agent_register(${this.cfg.label}) failed:`, fmtErr(error));
      // non-fatal: we do NOT refuse to start the MCP server just because the
      // registry table is gone. Heartbeats will keep retrying.
    } else {
      console.error(`agent ${this.cfg.label} registered (genome=${this.cfg.genomeLabel})`);
    }
    this.started = true;
    const intervalMs = this.cfg.heartbeatMs ?? 30_000;
    this.timer = setInterval(() => { void this.heartbeat(); }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();

    // graceful shutdown
    const stop = () => { void this.stop(); };
    process.once("SIGTERM", stop);
    process.once("SIGINT",  stop);
  }

  async heartbeat(status: "online" | "idle" | "stopping" = "online"): Promise<void> {
    try {
      const { error } = await this.db.rpc("agent_heartbeat", {
        p_label:  this.cfg.label,
        p_status: status,
      });
      if (error) {
        // If the row got wiped (e.g. DB reset), re-register.
        const msg = fmtErr(error).toLowerCase();
        if (msg.includes("not registered") || msg.includes("not found")) {
          console.error(`heartbeat: ${this.cfg.label} missing → re-registering`);
          await this.start();
        } else {
          console.error(`heartbeat(${this.cfg.label}) failed:`, fmtErr(error));
        }
      }
    } catch (e) {
      console.error(`heartbeat(${this.cfg.label}) threw:`, fmtErr(e));
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try {
      await this.db.rpc("agent_deregister", { p_label: this.cfg.label });
    } catch (e) {
      console.error(`deregister(${this.cfg.label}) failed:`, fmtErr(e));
    }
  }
}
