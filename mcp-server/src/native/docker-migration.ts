// Docker → PGlite migration helpers (sub-task 7 of #176).
//
// Pure-TS building blocks for the native-app first-run wizard described in
// `docs/native-migration-spike.md`. The wizard's orchestration (Docker-side
// probe + `docker exec pg_dump`) is shell-bound and lives closer to the
// Tauri shell — but the dump-handling, schema-load, and verification steps
// are pure TS that runs entirely against PGlite, so they are testable here
// in `mcp-server/` without any Docker dependency.
//
// What this module does NOT do:
//   - probe for an existing Docker stack (shell-out to `psql` / `docker ps`)
//   - invoke `pg_dump` (shell-out to `docker exec`)
//   - write the post-migration marker file
//   - prompt the user
//
// All four belong in the Tauri shell — sub-task 3 (#176). The point of this
// PR is that once `migrateFromDocker()` lives in the shell, it can call into
// the helpers here without re-implementing dump-handling.
//
// Reference: docs/native-migration-spike.md sections "What the wizard
// implementation has to do" steps 4-7 and "1. Vector serialisation is plain
// text — confirmed by inspection".

import type { PGlite } from "@electric-sql/pglite";

/**
 * Strip psql backslash-directives from a `pg_dump --inserts` output so the
 * remaining text is pure SQL that PGlite's `db.exec(sql)` can parse.
 *
 * Modern Debian-packaged pg_dump (PG 16.10+) emits SQL-injection-hardened
 * `\restrict <token>` / `\unrestrict <token>` pairs at the head and tail of
 * the dump; older / multi-DB dumps additionally start with `\connect`.
 * These are psql client commands, not SQL, and PGlite's parser will choke
 * on them (same way `db.exec("\\restrict abc")` does in plain Postgres).
 *
 * The filter is line-based and conservative — only drops lines that *start
 * with* the three known directives, so legitimate SQL containing the strings
 * (e.g. inside a string literal `'\\restrict me'`) is preserved verbatim.
 *
 * Spec: docs/native-migration-spike.md §"4. \restrict / \unrestrict
 * directives need a stripper".
 */
export function stripPsqlDirectives(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => {
      return (
        !line.startsWith("\\restrict") &&
        !line.startsWith("\\unrestrict") &&
        !line.startsWith("\\connect")
      );
    })
    .join("\n");
}

export interface ApplyDumpResult {
  /** UTF-8 byte size of the SQL actually executed (after stripping). */
  bytes: number;
  /** Wall-clock for `pg.exec(sql)` only — excludes the strip pass. */
  durationMs: number;
}

/**
 * Apply a stripped pg_dump output to a fresh PGlite instance in one shot.
 *
 * PRECONDITION: `pg` is a fresh PGlite — no migrations applied, no tables
 * created. The dump carries its own schema (full dump, not `--data-only`,
 * to dodge the circular-FK warning called out in the spike §3) and walking
 * a stripped dump through `pg.exec` is single-pass: schema, then INSERTs,
 * FK constraints deferred until COMMIT.
 *
 * Caller is responsible for opening + closing `pg`. We do not own the
 * lifecycle so the wizard can verify counts before deciding whether to
 * persist the dataDir or roll back.
 */
export async function applyDumpToPGlite(
  pg: PGlite,
  rawDump: string,
): Promise<ApplyDumpResult> {
  const sql = stripPsqlDirectives(rawDump);
  const start = Date.now();
  await pg.exec(sql);
  return {
    bytes: Buffer.byteLength(sql, "utf8"),
    durationMs: Date.now() - start,
  };
}

/**
 * Count rows in each named table — used by the wizard's pre-migration probe
 * (Docker side) and post-migration verification (PGlite side) to assert
 * row-equality before declaring success.
 *
 * Table names are validated against a strict identifier regex; an invalid
 * name throws synchronously rather than concatenating into SQL. The wizard
 * only ever passes a known whitelist (`memories`, `experiences`,
 * `generated_tasks`, …), but the guard makes the helper safe to expose for
 * follow-up tooling that might receive less-trusted input.
 */
export async function countTables(
  pg: PGlite,
  tables: readonly string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of tables) {
    if (!/^[a-z_][a-z0-9_]*$/.test(t)) {
      throw new Error(`invalid table name: ${t}`);
    }
    const r = await pg.query<{ c: number }>(`SELECT count(*)::int AS c FROM "${t}"`);
    counts[t] = r.rows[0]?.c ?? 0;
  }
  return counts;
}

export interface VerifyMismatch {
  table: string;
  source: number;
  target: number;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: VerifyMismatch[];
}

/**
 * Compare two row-count maps and report any table whose target count does
 * not match the source. Tables present only in `source` count as
 * mismatches (`target` defaults to 0); tables present only in `target` are
 * ignored — the wizard might add tables (e.g. PGlite-only metadata) that
 * the source dump does not carry, and that's fine.
 */
export function verifyMigration(
  source: Record<string, number>,
  target: Record<string, number>,
): VerifyResult {
  const mismatches: VerifyMismatch[] = [];
  for (const [t, s] of Object.entries(source)) {
    const tgt = target[t] ?? 0;
    if (s !== tgt) mismatches.push({ table: t, source: s, target: tgt });
  }
  return { ok: mismatches.length === 0, mismatches };
}
