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
  // Cognitive fields (migration 007)
  strength: number;
  importance: number;
  access_count: number;
  last_accessed_at?: string;
  valence: number;
  arousal: number;
  stage: "episodic" | "semantic" | "archived";
  pinned: boolean;
  decay_tau_days: number;
  useful_count: number;
}

export interface MemorySearchResult {
  id: string;
  content: string;
  category: string;
  tags: string[];
  metadata: Record<string, unknown>;
  source?: string;
  stage: string;
  strength: number;
  importance: number;
  access_count: number;
  pinned: boolean;
  relevance: number;
  strength_now: number;
  salience: number;
  effective_score: number;
  created_at: string;
  last_accessed_at?: string;
}

export interface SpreadResult {
  id: string;
  content: string;
  category: string;
  tags: string[];
  link_strength: number;
}

/** Polymorphic spread result — Migration 054 spread_activation_cross.
 *  `kind` widens as new Hebbian tables come online (today: memory,
 *  experience; future: lesson, trait, intention). */
export interface CrossSpreadResult {
  kind: "memory" | "experience" | "lesson" | "trait" | "intention";
  id: string;
  content: string;
  category: string;
  tags: string[];
  link_strength: number;
}

export interface CreateMemoryInput {
  content: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  source?: string;
  importance?: number;
  valence?: number;
  arousal?: number;
  pinned?: boolean;
  decay_tau_days?: number;
  project_id?: string | null;
}

export interface UpdateMemoryInput {
  id: string;
  content?: string;
  category?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  importance?: number;
  valence?: number;
  arousal?: number;
  pinned?: boolean;
}

export interface SearchMemoryInput {
  query: string;
  category?: string;
  limit?: number;
  vector_weight?: number;
}
