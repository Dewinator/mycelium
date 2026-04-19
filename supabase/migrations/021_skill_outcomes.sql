-- 021_skill_outcomes.sql — Skill-Performance-Tracking.
--
-- Beantwortet: "Welcher Skill hat bei welchem Task-Type zu welchem Outcome
-- geführt — und wie oft?" Gefüttert aus digest.tools_used × digest.outcome.
-- Dient als Recommendation-Basis in prime_context: "für refactor-Tasks in
-- TypeScript-Repos hat skill=coding-agent 3× success, 1× failure geliefert."

CREATE TABLE IF NOT EXISTS skill_outcomes (
  skill         TEXT NOT NULL,
  task_type     TEXT NOT NULL DEFAULT 'unknown',
  outcome       TEXT NOT NULL CHECK (outcome IN ('success','partial','failure','unknown')),
  n             INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0),
  last_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  avg_difficulty DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (avg_difficulty BETWEEN 0 AND 1),
  PRIMARY KEY (skill, task_type, outcome)
);

CREATE INDEX IF NOT EXISTS skill_outcomes_skill_idx      ON skill_outcomes (skill);
CREATE INDEX IF NOT EXISTS skill_outcomes_task_type_idx  ON skill_outcomes (task_type);
CREATE INDEX IF NOT EXISTS skill_outcomes_last_idx       ON skill_outcomes (last_at DESC);

-- ---------------------------------------------------------------------------
-- skill_record(skills[], task_type, outcome, difficulty) — inkrementelles
-- Upsert pro (skill × task_type × outcome). Returns Anzahl betroffener Rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION skill_record(
  p_skills     TEXT[],
  p_task_type  TEXT,
  p_outcome    TEXT,
  p_difficulty DOUBLE PRECISION DEFAULT 0.5
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_skill    TEXT;
  v_count    INTEGER := 0;
  v_task     TEXT := COALESCE(NULLIF(trim(p_task_type), ''), 'unknown');
  v_outcome  TEXT := COALESCE(NULLIF(trim(p_outcome),   ''), 'unknown');
  v_diff     DOUBLE PRECISION := GREATEST(0.0, LEAST(1.0, COALESCE(p_difficulty, 0.5)));
BEGIN
  IF p_skills IS NULL OR array_length(p_skills, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- Validiere outcome — sonst CHECK-Constraint-Error im Upsert
  IF v_outcome NOT IN ('success','partial','failure','unknown') THEN
    v_outcome := 'unknown';
  END IF;

  FOREACH v_skill IN ARRAY p_skills LOOP
    IF v_skill IS NULL OR trim(v_skill) = '' THEN
      CONTINUE;
    END IF;

    INSERT INTO skill_outcomes (skill, task_type, outcome, n, last_at, avg_difficulty)
    VALUES (trim(v_skill), v_task, v_outcome, 1, NOW(), v_diff)
    ON CONFLICT (skill, task_type, outcome) DO UPDATE SET
      n              = skill_outcomes.n + 1,
      last_at        = NOW(),
      avg_difficulty = (skill_outcomes.avg_difficulty * skill_outcomes.n + v_diff)
                       / (skill_outcomes.n + 1);

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- skill_stats() — Dashboard-Aggregation pro Skill (über alle Task-Types).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION skill_stats()
RETURNS JSONB
LANGUAGE SQL
STABLE
AS $$
  SELECT jsonb_build_object(
    'skills', COALESCE(jsonb_agg(r ORDER BY (r->>'n_total')::int DESC), '[]'::jsonb),
    'generated_at', NOW()
  )
  FROM (
    SELECT jsonb_build_object(
      'skill', skill,
      'n_total',  SUM(n),
      'n_success', SUM(n) FILTER (WHERE outcome = 'success'),
      'n_partial', SUM(n) FILTER (WHERE outcome = 'partial'),
      'n_failure', SUM(n) FILTER (WHERE outcome = 'failure'),
      'n_unknown', SUM(n) FILTER (WHERE outcome = 'unknown'),
      'success_rate', CASE WHEN SUM(n) FILTER (WHERE outcome <> 'unknown') > 0
                           THEN SUM(n) FILTER (WHERE outcome = 'success')::DOUBLE PRECISION
                              / SUM(n) FILTER (WHERE outcome <> 'unknown')
                           ELSE NULL END,
      'avg_difficulty', AVG(avg_difficulty),
      'last_at', MAX(last_at),
      'task_types', (
        SELECT jsonb_object_agg(task_type, cnt)
        FROM (SELECT task_type, SUM(n) AS cnt FROM skill_outcomes s2
              WHERE s2.skill = s1.skill GROUP BY task_type) t
      )
    ) AS r
    FROM skill_outcomes s1
    GROUP BY skill
  ) sub;
$$;

-- ---------------------------------------------------------------------------
-- skill_recommend(task_type, min_evidence) — Top-Skills für einen Task-Type,
-- sortiert nach success_rate × evidence (Laplace-smoothed).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION skill_recommend(
  p_task_type    TEXT,
  p_min_evidence INT DEFAULT 2,
  p_limit        INT DEFAULT 5
)
RETURNS TABLE (
  skill         TEXT,
  success_rate  DOUBLE PRECISION,
  n_total       INTEGER,
  n_success     INTEGER,
  n_failure     INTEGER,
  score         DOUBLE PRECISION
)
LANGUAGE SQL
STABLE
AS $$
  WITH agg AS (
    SELECT
      s.skill,
      SUM(s.n)::INTEGER                                    AS n_total,
      SUM(s.n) FILTER (WHERE s.outcome = 'success')::INT   AS n_success,
      SUM(s.n) FILTER (WHERE s.outcome = 'failure')::INT   AS n_failure,
      SUM(s.n) FILTER (WHERE s.outcome <> 'unknown')::INT  AS n_known
    FROM skill_outcomes s
    WHERE s.task_type = p_task_type OR p_task_type IS NULL
    GROUP BY s.skill
  )
  SELECT
    agg.skill,
    CASE WHEN n_known > 0 THEN n_success::DOUBLE PRECISION / n_known ELSE NULL END AS success_rate,
    n_total,
    n_success,
    n_failure,
    -- Laplace-smoothed score: verhindert dass ein 1-von-1 Treffer die Liste dominiert
    (n_success + 1.0) / (n_known + 2.0) * LN(1 + n_total) AS score
  FROM agg
  WHERE n_total >= p_min_evidence
  ORDER BY score DESC NULLS LAST
  LIMIT p_limit;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON skill_outcomes TO anon, service_role;
GRANT EXECUTE ON FUNCTION skill_record(TEXT[], TEXT, TEXT, DOUBLE PRECISION) TO anon, service_role;
GRANT EXECUTE ON FUNCTION skill_stats()                                       TO anon, service_role;
GRANT EXECUTE ON FUNCTION skill_recommend(TEXT, INT, INT)                     TO anon, service_role;
