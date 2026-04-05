#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createEmbeddingProvider } from "./services/embeddings.js";
import { MemoryService } from "./services/supabase.js";
import { rememberSchema, remember } from "./tools/remember.js";
import { recallSchema, recall } from "./tools/recall.js";
import { forgetSchema, forget } from "./tools/forget.js";
import { updateSchema, update } from "./tools/update.js";
import { listSchema, list } from "./tools/list.js";
import { importSchema, importMarkdown } from "./tools/import.js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://localhost:54321";
const SUPABASE_KEY = process.env.SUPABASE_KEY ?? "";

if (!SUPABASE_KEY) {
  console.error(
    "SUPABASE_KEY is required. Set it as an environment variable or in your MCP server config."
  );
  process.exit(1);
}

const embeddings = createEmbeddingProvider();
const memoryService = new MemoryService(SUPABASE_URL, SUPABASE_KEY, embeddings);

const server = new McpServer({
  name: "vector-memory",
  version: "0.1.0",
});

server.tool(
  "remember",
  "Store a new memory with automatic embedding generation. Use for important facts, decisions, people info, or project details.",
  rememberSchema.shape,
  async (input) => remember(memoryService, rememberSchema.parse(input))
);

server.tool(
  "recall",
  "Search memories using semantic similarity and keyword matching. Returns the most relevant memories for a query.",
  recallSchema.shape,
  async (input) => recall(memoryService, recallSchema.parse(input))
);

server.tool(
  "forget",
  "Delete a specific memory by its UUID.",
  forgetSchema.shape,
  async (input) => forget(memoryService, forgetSchema.parse(input))
);

server.tool(
  "update_memory",
  "Update an existing memory. If content changes, the embedding is automatically regenerated.",
  updateSchema.shape,
  async (input) => update(memoryService, updateSchema.parse(input))
);

server.tool(
  "list_memories",
  "List stored memories, optionally filtered by category. Returns most recent first.",
  listSchema.shape,
  async (input) => list(memoryService, listSchema.parse(input))
);

server.tool(
  "import_markdown",
  "Import existing openClaw markdown memory files into the vector database. Supports dry_run mode.",
  importSchema.shape,
  async (input) => importMarkdown(memoryService, importSchema.parse(input))
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // MCP server is now running — do not use console.log (corrupts stdio JSON-RPC)
  console.error("vector-memory MCP server started");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
