-- 034_breeding_diversity.sql — Profile-Embedding (Centroid) + Vorfahren-Hülle
--
-- Zweck: Voraussetzung für Anti-Inzucht (Wright's F via ancestors[]) und für
-- Diversity-Sortierung im Tinder-UI (cosine-Distance zwischen profile_embeddings).
--
-- Kein Eingriff in bestehende Logik. Reine additive Erweiterung von
-- agent_genomes. Der profile_embedding-Wert wird lazy berechnet — das
-- Refresh-RPC liegt in Migration 035.

-- ---------------------------------------------------------------------------
-- Voraussetzung: pgvector (schon aktiviert in 001_enable_pgvector.sql)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_genomes
  ADD COLUMN IF NOT EXISTS profile_embedding     VECTOR(768),
  ADD COLUMN IF NOT EXISTS profile_variance      DOUBLE PRECISION,    -- mittlere intra-genome Distanz; "Persönlichkeitsbreite"
  ADD COLUMN IF NOT EXISTS profile_n             INTEGER,             -- aus wievielen Memories berechnet
  ADD COLUMN IF NOT EXISTS profile_refreshed_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ancestors             UUID[] NOT NULL DEFAULT '{}';  -- transitive Hülle parent → grandparent → ...

-- HNSW-Index für Tinder-Ranking via cosine-Distance zwischen Profilen.
CREATE INDEX IF NOT EXISTS agent_genomes_profile_emb_idx
  ON agent_genomes USING hnsw (profile_embedding vector_cosine_ops);

-- GIN für Vorfahren-Lookup ("ist X Vorfahre von Y?")
CREATE INDEX IF NOT EXISTS agent_genomes_ancestors_gin
  ON agent_genomes USING GIN (ancestors);

-- ---------------------------------------------------------------------------
-- _genome_compute_ancestors(p_id) — rekursive Hülle aller Vorfahren-IDs
-- Nutzt agent_genomes.parent_ids (UUID[]).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _genome_compute_ancestors(p_id UUID)
RETURNS UUID[]
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_result UUID[];
BEGIN
  WITH RECURSIVE walk(id, depth) AS (
    -- Startknoten: direkte Eltern
    SELECT UNNEST(parent_ids), 1
    FROM agent_genomes WHERE id = p_id
    UNION
    -- Rekursion: Eltern der bereits gesammelten Knoten
    SELECT UNNEST(g.parent_ids), w.depth + 1
    FROM walk w
    JOIN agent_genomes g ON g.id = w.id
    WHERE w.depth < 32  -- harte Grenze gegen pathologische Zyklen
  )
  SELECT COALESCE(ARRAY_AGG(DISTINCT id), '{}'::UUID[]) INTO v_result FROM walk WHERE id IS NOT NULL;
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- _genome_refresh_ancestors_trigger — bei INSERT/UPDATE von parent_ids
--   wird ancestors[] neu gerechnet. Bei UPDATE eines Vorfahren propagiert
--   sich das nicht automatisch — Backfill-RPC unten erledigt das einmalig.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _genome_refresh_ancestors_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Selbst-Vorfahre verboten (Zyklus-Schutz)
  IF NEW.id = ANY(NEW.parent_ids) THEN
    RAISE EXCEPTION 'genome cannot be its own parent';
  END IF;
  NEW.ancestors := _genome_compute_ancestors(NEW.id);
  -- Selbst-Vorfahre via Rekursion verboten
  IF NEW.id = ANY(NEW.ancestors) THEN
    RAISE EXCEPTION 'cycle detected: genome % would be its own ancestor', NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_genomes_refresh_ancestors ON agent_genomes;
CREATE TRIGGER agent_genomes_refresh_ancestors
  BEFORE INSERT OR UPDATE OF parent_ids ON agent_genomes
  FOR EACH ROW EXECUTE FUNCTION _genome_refresh_ancestors_trigger();

-- ---------------------------------------------------------------------------
-- Backfill: einmalig alle bestehenden Genome neu berechnen.
-- Mehrere Pässe, weil ancestors transitiv sind und der Trigger nur das
-- aktuell berührte Genom rechnet.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_changed INT := 1;
  v_pass    INT := 0;
BEGIN
  WHILE v_changed > 0 AND v_pass < 16 LOOP
    v_pass := v_pass + 1;
    WITH upd AS (
      SELECT id, _genome_compute_ancestors(id) AS new_anc
      FROM agent_genomes
    )
    UPDATE agent_genomes g SET ancestors = u.new_anc
    FROM upd u
    WHERE g.id = u.id AND g.ancestors IS DISTINCT FROM u.new_anc;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION _genome_compute_ancestors(UUID) TO anon, service_role;

-- Schema-Cache-Reload bitte manuell:
-- docker exec vectormemory-db psql -U postgres -d vectormemory -c "NOTIFY pgrst, 'reload schema';"
