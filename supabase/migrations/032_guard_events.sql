-- 032_guard_events.sql — Audit-Log für Prompt-Injection-Guard
--
-- Jeder extern eingehende Content (HackerNews-Titel, RSS-Feed, User-Profile,
-- fremde Bot-Profile) wird durch den Guard-Sidecar klassifiziert. Wir logen
-- *jede* Klassifikation mit Hash + Verdict. Das hat zwei Zwecke:
--
--   1. Transparenz für den User ("was hat der Guard blockiert?")
--   2. Feedback-Loop für den Classifier — bei false-positives wissen wir wo
--      wir nachtunen muessen.
--
-- content_hash (sha256) statt Plain-Content speichern: damit bei false-pos-
-- Analyse wir nachsehen koennen, aber ohne den Rohtext zum Reiz-Honeypot zu
-- machen. Im Zweifel ist malicious content DSGVO/ethisch heikel zu speichern.

CREATE TABLE IF NOT EXISTS guard_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash    TEXT NOT NULL,              -- sha256 des klassifizierten content
  content_preview TEXT,                       -- erste 200 chars, fuer Debug
  content_length  INTEGER,                    -- volle Laenge
  source          TEXT NOT NULL,              -- 'motivation:hackernews', 'tinder:profile', ...
  source_id       TEXT,                       -- ggf. Id des Ursprungs (stimulus_id, genome_label, ...)
  verdict         TEXT NOT NULL
                  CHECK (verdict IN ('safe','suspicious','malicious','error')),
  score           DOUBLE PRECISION,           -- Confidence 0..1 (wenn Classifier liefert)
  reason          TEXT,                       -- Classifier-Begruendung
  classifier      TEXT NOT NULL,              -- 'llama-guard3:1b', 'regex-only', ...
  structural_hits JSONB NOT NULL DEFAULT '[]',-- welche Regex-Patterns getroffen haben
  metadata        JSONB NOT NULL DEFAULT '{}',
  action_taken    TEXT                        -- 'blocked','demoted','allowed','flagged'
);

CREATE INDEX IF NOT EXISTS guard_events_created_idx ON guard_events (created_at DESC);
CREATE INDEX IF NOT EXISTS guard_events_verdict_idx ON guard_events (verdict);
CREATE INDEX IF NOT EXISTS guard_events_source_idx  ON guard_events (source);
CREATE INDEX IF NOT EXISTS guard_events_hash_idx    ON guard_events (content_hash);

-- ---------------------------------------------------------------------------
-- guard_summary() — Dashboard-Overview: counts per verdict last 24h / 7d
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guard_summary()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_24h JSONB;
  v_7d  JSONB;
  v_src JSONB;
  v_last JSONB;
BEGIN
  SELECT COALESCE(jsonb_object_agg(verdict, n), '{}'::jsonb) INTO v_24h FROM (
    SELECT verdict, COUNT(*) n FROM guard_events
    WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY verdict
  ) x;
  SELECT COALESCE(jsonb_object_agg(verdict, n), '{}'::jsonb) INTO v_7d FROM (
    SELECT verdict, COUNT(*) n FROM guard_events
    WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY verdict
  ) x;
  SELECT COALESCE(jsonb_object_agg(source, n), '{}'::jsonb) INTO v_src FROM (
    SELECT source, COUNT(*) n FROM guard_events
    WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY source
  ) x;
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_last FROM (
    SELECT id, created_at, verdict, score, source, content_preview, reason, action_taken
    FROM guard_events
    WHERE verdict IN ('suspicious','malicious')
    ORDER BY created_at DESC LIMIT 20
  ) x;
  RETURN jsonb_build_object(
    'by_verdict_24h', v_24h,
    'by_verdict_7d',  v_7d,
    'by_source_7d',   v_src,
    'recent_blocks',  v_last,
    'generated_at',   NOW()
  );
END;
$$;

GRANT SELECT, INSERT ON guard_events           TO anon, service_role;
GRANT EXECUTE ON FUNCTION guard_summary()      TO anon, service_role;
