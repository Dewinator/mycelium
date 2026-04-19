-- 036_fix_ancestors_trigger.sql — Fix für BEFORE-INSERT-Trigger
--
-- Bug: _genome_refresh_ancestors_trigger rief _genome_compute_ancestors(NEW.id)
-- — aber bei BEFORE INSERT ist die Zeile noch nicht in der Tabelle, also gibt
-- die rekursive Query 0 Ergebnisse. Konsequenz: Kinder hatten ancestors={}
-- und der Wright-F-Coefficient war fälschlich 0 → Inzucht-Schutz war wirkungslos.
--
-- Fix: Trigger berechnet die Vorfahren-Hülle direkt aus NEW.parent_ids
-- (die existieren in NEW), inkl. ancestors-Spalten der direkten Eltern.

CREATE OR REPLACE FUNCTION _genome_refresh_ancestors_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_anc UUID[];
BEGIN
  IF NEW.id = ANY(NEW.parent_ids) THEN
    RAISE EXCEPTION 'genome cannot be its own parent';
  END IF;

  -- Direkte Eltern + ihre transitive Hülle
  WITH parents AS (
    SELECT id, ancestors FROM agent_genomes WHERE id = ANY(NEW.parent_ids)
  )
  SELECT COALESCE(ARRAY_AGG(DISTINCT x), '{}'::UUID[]) INTO v_anc
  FROM (
    SELECT UNNEST(NEW.parent_ids) AS x
    UNION
    SELECT UNNEST(p.ancestors) FROM parents p
  ) all_anc
  WHERE x IS NOT NULL;

  IF NEW.id = ANY(v_anc) THEN
    RAISE EXCEPTION 'cycle detected: genome % would be its own ancestor', NEW.id;
  END IF;
  NEW.ancestors := v_anc;
  RETURN NEW;
END;
$$;

-- Backfill bestehender Genome (idempotent — recomputed ancestors aus parents).
DO $$
DECLARE
  v_changed INT := 1;
  v_pass    INT := 0;
BEGIN
  WHILE v_changed > 0 AND v_pass < 16 LOOP
    v_pass := v_pass + 1;
    WITH compute AS (
      SELECT
        g.id,
        COALESCE((
          SELECT ARRAY_AGG(DISTINCT x)
          FROM (
            SELECT UNNEST(g.parent_ids) AS x
            UNION
            SELECT UNNEST(p.ancestors)
            FROM agent_genomes p
            WHERE p.id = ANY(g.parent_ids)
          ) all_anc
          WHERE x IS NOT NULL
        ), '{}'::UUID[]) AS new_anc
      FROM agent_genomes g
    )
    UPDATE agent_genomes g
       SET ancestors = c.new_anc
      FROM compute c
     WHERE g.id = c.id AND g.ancestors IS DISTINCT FROM c.new_anc;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  END LOOP;
END $$;
