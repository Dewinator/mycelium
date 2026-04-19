-- 027_genome_inheritance.sql — Schicht 5c Erweiterung: Volle Wissensvererbung
--
-- Bisher: breed_agents kopierte nur "Instinkt-Schicht" (values, interests,
-- numerische Traits). Das Wissen (Memories, Experiences, Lessons, Soul-Traits)
-- blieb bei den Eltern zurueck — ein neugeborenes Kind haette mit leerem
-- Gedaechtnis gestartet.
--
-- Jetzt: das Kind erbt Pointer (UUID-Arrays) auf das vollstaendige Wissen
-- beider Eltern. Daten werden NICHT dupliziert — das Kind liest aus dem
-- gemeinsamen Pool und kann selbst darauf zurueckgreifen.
--
-- Biologisches Vorbild: Lamarcksche Vererbung, verstaerkt durch neuere
-- epigenetische + RNA-basierte Befunde zur Weitergabe erworbener Information.
-- Wir machen es aber vollstaendig — nicht nur Instinkt, nicht nur Reflexe.

ALTER TABLE agent_genomes
  ADD COLUMN IF NOT EXISTS inherited_memory_ids      UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS inherited_experience_ids  UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS inherited_lesson_ids      UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS inherited_trait_ids       UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS inheritance_mode          TEXT NOT NULL DEFAULT 'full'
                                                     CHECK (inheritance_mode IN ('none','top','full'));

-- GIN-Indizes damit Array-Lookups schnell bleiben
CREATE INDEX IF NOT EXISTS genome_inherited_memory_gin
  ON agent_genomes USING GIN (inherited_memory_ids);
CREATE INDEX IF NOT EXISTS genome_inherited_exp_gin
  ON agent_genomes USING GIN (inherited_experience_ids);
CREATE INDEX IF NOT EXISTS genome_inherited_lesson_gin
  ON agent_genomes USING GIN (inherited_lesson_ids);
CREATE INDEX IF NOT EXISTS genome_inherited_trait_gin
  ON agent_genomes USING GIN (inherited_trait_ids);

-- ---------------------------------------------------------------------------
-- genome_inheritance(p_label) — wie viel Wissen hat dieses Genom geerbt?
-- Liefert Counts + Stichprobe fuer Dashboard-Anzeige.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_inheritance(p_label TEXT DEFAULT 'main')
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  g agent_genomes%ROWTYPE;
BEGIN
  SELECT * INTO g FROM agent_genomes WHERE label = p_label;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('exists', false, 'label', p_label);
  END IF;

  RETURN jsonb_build_object(
    'exists',       true,
    'label',        g.label,
    'generation',   g.generation,
    'parent_ids',   g.parent_ids,
    'inheritance_mode', g.inheritance_mode,
    'memories',     COALESCE(array_length(g.inherited_memory_ids, 1), 0),
    'experiences',  COALESCE(array_length(g.inherited_experience_ids, 1), 0),
    'lessons',      COALESCE(array_length(g.inherited_lesson_ids, 1), 0),
    'traits',       COALESCE(array_length(g.inherited_trait_ids, 1), 0),
    'sample_memory_preview', (
      SELECT jsonb_agg(jsonb_build_object('id', m.id, 'content', LEFT(m.content, 100)))
      FROM memories m
      WHERE m.id = ANY (g.inherited_memory_ids)
      LIMIT 5
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Gen-1 'main' ist die aktive Instanz: bei Breeding ruft das MCP-Tool
-- genome_inheritance_refresh, das die aktuellen Memory/Exp/Lesson/Trait-IDs
-- einsammelt. Fuer gen-1 selbst koennen wir das optional bei Bedarf triggern.
-- Hier KEIN automatischer Default-Fill, weil 'main' Gen-1 ist und kein Elter hat.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION genome_collect_current_knowledge(p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_mem UUID[];
  v_exp UUID[];
  v_les UUID[];
  v_tra UUID[];
BEGIN
  -- Memories: alle nicht-archivierten
  SELECT COALESCE(array_agg(id), '{}') INTO v_mem FROM memories WHERE stage <> 'archived';
  -- Experiences: alle
  SELECT COALESCE(array_agg(id), '{}') INTO v_exp FROM experiences;
  -- Lessons: alle
  SELECT COALESCE(array_agg(id), '{}') INTO v_les FROM lessons;
  -- Soul-Traits: alle
  SELECT COALESCE(array_agg(id), '{}') INTO v_tra FROM soul_traits;

  UPDATE agent_genomes SET
    inherited_memory_ids     = v_mem,
    inherited_experience_ids = v_exp,
    inherited_lesson_ids     = v_les,
    inherited_trait_ids      = v_tra,
    updated_at               = NOW()
  WHERE label = p_label;

  RETURN jsonb_build_object(
    'label', p_label,
    'memories', COALESCE(array_length(v_mem, 1), 0),
    'experiences', COALESCE(array_length(v_exp, 1), 0),
    'lessons', COALESCE(array_length(v_les, 1), 0),
    'traits', COALESCE(array_length(v_tra, 1), 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION genome_inheritance(TEXT)            TO anon, service_role;
GRANT EXECUTE ON FUNCTION genome_collect_current_knowledge(TEXT) TO anon, service_role;
