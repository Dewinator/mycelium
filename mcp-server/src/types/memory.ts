export interface Memory {
  id: string;
  content: string;
  category: string;
  tags: string[];
  embedding?: number[];
  metadata: Record<string, unknown>;
  source?: string;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  similarity: number;
  created_at: string;
}

export interface CreateMemoryInput {
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface SearchMemoryInput {
  query: string;
  category?: string;
  limit?: number;
  vector_weight?: number;
}
