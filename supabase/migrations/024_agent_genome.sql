-- 024_agent_genome.sql — Schicht 5c: Agent-Genome + Fitness-Historie
--
-- Konzept: der produktiv laufende Agent ist Generation 1. Weitere Genome
-- werden nur mit expliziter Genehmigung angelegt (siehe Tool-Layer). Diese
-- Migration stellt das Substrat bereit + Fitness-Historie.
--
-- Ethik: NICHTS in dieser Migration reproduziert Agenten automatisch. Das
-- breeding passiert ausschliesslich ueber das MCP-Tool `breed_agents` und ist
-- doppelt approval-gated (ENV-Flag + explizite user ack).

CREATE TABLE IF NOT EXISTS agent_genomes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label                 TEXT NOT NULL UNIQUE,
  generation            INTEGER NOT NULL DEFAULT 1,
  parent_ids            UUID[] NOT NULL DEFAULT '{}',
  status                TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','culled','archived')),
  -- traits
  values                TEXT[] NOT NULL DEFAULT '{}',
  interests             TEXT[] NOT NULL DEFAULT '{}',
  curiosity_baseline    DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  frustration_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.7,
  exploration_rate      DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  risk_tolerance        DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  mutation_rate         DOUBLE PRECISION NOT NULL DEFAULT 0.05,
  top_memory_ids        UUID[] NOT NULL DEFAULT '{}',
  -- provenance
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes                 TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS agent_genomes_status_idx ON agent_genomes (status);
CREATE INDEX IF NOT EXISTS agent_genomes_generation_idx ON agent_genomes (generation);

-- Fitness-Historie fuer Trend-Plots + Reproduktions-Entscheidungen
CREATE TABLE IF NOT EXISTS agent_fitness_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  genome_id     UUID NOT NULL REFERENCES agent_genomes(id) ON DELETE CASCADE,
  window_days   INTEGER NOT NULL DEFAULT 30,
  avg_outcome   DOUBLE PRECISION,
  growth        DOUBLE PRECISION,
  breadth       DOUBLE PRECISION,
  autonomy      DOUBLE PRECISION,
  fitness       DOUBLE PRECISION NOT NULL,
  based_on_n    INTEGER NOT NULL DEFAULT 0,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  details       JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS agent_fitness_genome_idx ON agent_fitness_history (genome_id, computed_at DESC);

-- ---------------------------------------------------------------------------
-- Seed: aktuelle produktive Instanz als Generation 1 (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO agent_genomes (
  label, generation, values, interests,
  curiosity_baseline, frustration_threshold, exploration_rate, risk_tolerance,
  mutation_rate, notes
) VALUES (
  'main',
  1,
  ARRAY['ehrlich','konkret','ownership','neugierig','respektvoll','praktisch'],
  ARRAY['ki-agent','active-inference','openclaw','veranstaltungstechnik',
        'self-hosting','macOS','swift','phasex','eab','nivtec'],
  0.55, 0.70, 0.55, 0.45,
  0.05,
  'Gen-1 seed aus der Erweiterung-Rollout (2026-04). Entspricht dem aktuell aktiven openClaw main-agent.'
)
ON CONFLICT (label) DO NOTHING;

-- ---------------------------------------------------------------------------
-- genome_list() — Live-Uebersicht mit letztem Fitness-Wert
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_list()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.generation, x.label), '[]'::jsonb)
  FROM (
    SELECT
      g.id, g.label, g.generation, g.status, g.parent_ids,
      g.values, g.interests,
      g.curiosity_baseline, g.frustration_threshold,
      g.exploration_rate, g.risk_tolerance, g.mutation_rate,
      g.created_at, g.updated_at, g.notes,
      (SELECT to_jsonb(h) FROM agent_fitness_history h
         WHERE h.genome_id = g.id ORDER BY computed_at DESC LIMIT 1) AS latest_fitness
    FROM agent_genomes g
  ) x;
$$;

GRANT SELECT, INSERT, UPDATE ON agent_genomes            TO anon, service_role;
GRANT SELECT, INSERT          ON agent_fitness_history   TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_list()                  TO anon, service_role;
