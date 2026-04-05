import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type {
  Memory,
  MemorySearchResult,
  CreateMemoryInput,
  UpdateMemoryInput,
} from "../types/memory.js";
import type { EmbeddingProvider } from "./embeddings.js";

export class MemoryService {
  private db: SupabaseClient;
  private embeddings: EmbeddingProvider;
  private healthy = true;

  constructor(supabaseUrl: string, supabaseKey: string, embeddings: EmbeddingProvider) {
    this.db = createClient(supabaseUrl, supabaseKey);
    this.embeddings = embeddings;
  }

  /** Check if Supabase is reachable */
  async healthCheck(): Promise<boolean> {
    try {
      const { error } = await this.db.from("memories").select("id").limit(1);
      this.healthy = !error;
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  get isHealthy(): boolean {
    return this.healthy;
  }

  async create(input: CreateMemoryInput): Promise<Memory> {
    const embedding = await this.embeddings.embed(input.content);

    const { data, error } = await this.db
      .from("memories")
      .insert({
        content: input.content,
        category: input.category ?? "general",
        tags: input.tags ?? [],
        embedding: JSON.stringify(embedding),
        metadata: input.metadata ?? {},
        source: input.source ?? null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create memory: ${error.message}`);
    return data as Memory;
  }

  async search(
    query: string,
    category?: string,
    limit: number = 10,
    vectorWeight: number = 0.7
  ): Promise<MemorySearchResult[]> {
    const queryEmbedding = await this.embeddings.embed(query);

    const { data, error } = await this.db.rpc("match_memories", {
      query_embedding: JSON.stringify(queryEmbedding),
      query_text: query,
      match_count: limit,
      filter_category: category ?? null,
      vector_weight: vectorWeight,
    });

    if (error) throw new Error(`Failed to search memories: ${error.message}`);
    return (data ?? []) as MemorySearchResult[];
  }

  async get(id: string): Promise<Memory | null> {
    const { data, error } = await this.db
      .from("memories")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") return null;
      throw new Error(`Failed to get memory: ${error.message}`);
    }
    return data as Memory;
  }

  async update(input: UpdateMemoryInput): Promise<Memory> {
    const updates: Record<string, unknown> = {};
    if (input.content !== undefined) {
      updates.content = input.content;
      updates.embedding = JSON.stringify(
        await this.embeddings.embed(input.content)
      );
    }
    if (input.category !== undefined) updates.category = input.category;
    if (input.tags !== undefined) updates.tags = input.tags;
    if (input.metadata !== undefined) updates.metadata = input.metadata;

    const { data, error } = await this.db
      .from("memories")
      .update(updates)
      .eq("id", input.id)
      .select()
      .single();

    if (error) throw new Error(`Failed to update memory: ${error.message}`);
    return data as Memory;
  }

  async delete(id: string): Promise<boolean> {
    const { error } = await this.db
      .from("memories")
      .delete()
      .eq("id", id);

    if (error) throw new Error(`Failed to delete memory: ${error.message}`);
    return true;
  }

  async list(category?: string, limit: number = 20): Promise<Memory[]> {
    let query = this.db
      .from("memories")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (category) {
      query = query.eq("category", category);
    }

    const { data, error } = await query;

    if (error) throw new Error(`Failed to list memories: ${error.message}`);
    return (data ?? []) as Memory[];
  }
}
