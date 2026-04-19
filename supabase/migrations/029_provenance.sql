-- 029_provenance.sql — "Wer hat das erzeugt?" als optionales Tag
--
-- Der globale Pool bleibt geteilt — jeder Agent kann jede Erinnerung lesen.
-- Aber beim Speichern wird markiert, welcher Agent die Erinnerung in die
-- Welt gesetzt hat. Beim Breeding/Pairing koennen wir so Wissens-Herkunft
-- visualisieren ("Mutter hat diese 400 Memories beigesteuert, Vater diese 300").
--
-- Backfill: alles bisher Existierende wird dem gen-1 'main' zugeschrieben —
-- das war zum Zeitpunkt der Migration die einzige aktive Instanz.

ALTER TABLE memories    ADD COLUMN IF NOT EXISTS created_by_agent_id UUID REFERENCES agent_genomes(id);
ALTER TABLE experiences ADD COLUMN IF NOT EXISTS created_by_agent_id UUID REFERENCES agent_genomes(id);
ALTER TABLE lessons     ADD COLUMN IF NOT EXISTS created_by_agent_id UUID REFERENCES agent_genomes(id);
ALTER TABLE soul_traits ADD COLUMN IF NOT EXISTS created_by_agent_id UUID REFERENCES agent_genomes(id);

CREATE INDEX IF NOT EXISTS memories_created_by_idx    ON memories    (created_by_agent_id);
CREATE INDEX IF NOT EXISTS experiences_created_by_idx ON experiences (created_by_agent_id);
CREATE INDEX IF NOT EXISTS lessons_created_by_idx     ON lessons     (created_by_agent_id);
CREATE INDEX IF NOT EXISTS soul_traits_created_by_idx ON soul_traits (created_by_agent_id);

-- Backfill auf 'main' — vor dieser Migration war das die einzige aktive Instanz.
DO $$
DECLARE
  v_main UUID;
BEGIN
  SELECT id INTO v_main FROM agent_genomes WHERE label = 'main' LIMIT 1;
  IF v_main IS NOT NULL THEN
    UPDATE memories    SET created_by_agent_id = v_main WHERE created_by_agent_id IS NULL;
    UPDATE experiences SET created_by_agent_id = v_main WHERE created_by_agent_id IS NULL;
    UPDATE lessons     SET created_by_agent_id = v_main WHERE created_by_agent_id IS NULL;
    UPDATE soul_traits SET created_by_agent_id = v_main WHERE created_by_agent_id IS NULL;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- provenance_summary(genome_label) — wer hat wieviel in den geteilten Pool
-- gelegt? Fuer Dashboard + Paarungs-Logik.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION provenance_summary(p_label TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_label IS NOT NULL THEN
    SELECT id INTO v_id FROM agent_genomes WHERE label = p_label;
    RETURN jsonb_build_object(
      'genome_label', p_label,
      'genome_id',    v_id,
      'memories',     (SELECT COUNT(*) FROM memories    WHERE created_by_agent_id = v_id),
      'experiences',  (SELECT COUNT(*) FROM experiences WHERE created_by_agent_id = v_id),
      'lessons',      (SELECT COUNT(*) FROM lessons     WHERE created_by_agent_id = v_id),
      'soul_traits',  (SELECT COUNT(*) FROM soul_traits WHERE created_by_agent_id = v_id)
    );
  END IF;
  -- Default: alle Genome auf einmal
  RETURN (
    SELECT COALESCE(jsonb_object_agg(x.label, x.counts), '{}'::jsonb)
    FROM (
      SELECT g.label,
        jsonb_build_object(
          'memories',    (SELECT COUNT(*) FROM memories    WHERE created_by_agent_id = g.id),
          'experiences', (SELECT COUNT(*) FROM experiences WHERE created_by_agent_id = g.id),
          'lessons',     (SELECT COUNT(*) FROM lessons     WHERE created_by_agent_id = g.id),
          'soul_traits', (SELECT COUNT(*) FROM soul_traits WHERE created_by_agent_id = g.id)
        ) AS counts
      FROM agent_genomes g
    ) x
  );
END;
$$;

GRANT EXECUTE ON FUNCTION provenance_summary(TEXT) TO anon, service_role;
