-- 030_genome_models.sql — Modellwahl als Teil der DNA (vererbbar)
--
-- Jedes Genom traegt seine Modellwahl: das lokal/autonom arbeitende base_model
-- (meistens Sonnet fuer uns, ggf. 7B fuer eine spaetere Laien-Variante) und
-- das teacher_model fuer Eskalationen (Opus / Haiku / groesseres lokales).
--
-- `workspace_path` dokumentiert wo die Workspace-Dateien (SOUL.md, AGENTS.md,
-- MEMORY.md) dieses Genoms liegen — wird beim Provisionieren neuer Instanzen
-- aus dem Template kopiert.

ALTER TABLE agent_genomes
  ADD COLUMN IF NOT EXISTS base_model      TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  ADD COLUMN IF NOT EXISTS teacher_model   TEXT NOT NULL DEFAULT 'claude-opus-4-7',
  ADD COLUMN IF NOT EXISTS workspace_path  TEXT,
  ADD COLUMN IF NOT EXISTS provider        TEXT NOT NULL DEFAULT 'anthropic'
                                           CHECK (provider IN ('anthropic','ollama','hybrid'));

-- workspace_path bleibt per Default NULL. Der Install-/Provision-Flow setzt ihn
-- auf den konkreten Host-Pfad (typisch: $HOME/.openclaw/workspace). Wir ankern
-- hier bewusst keinen Absolut-Pfad in die Migration — das würde auf jedem Host
-- beim Mitlesen der Migrations-History das falsche Home reinschreiben.

GRANT SELECT, UPDATE ON agent_genomes TO anon, service_role;
