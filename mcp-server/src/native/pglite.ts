// PGlite adapter — drops in for `@supabase/postgrest-js`'s PostgrestClient
// where MemoryService and friends consume it. Speaks the same `.from(t).select|
// insert|update|delete().eq|neq|in|or|order|limit().single|maybeSingle()` chain
// shape and the same `.rpc(name, args)` shape, returning `{ data, error }`.
//
// Why this exists:
//   Issue #184 (sub-task of #176) graduates the throwaway PGlite spike
//   (experiments/native-pg/spike-pglite.mjs, validated under #179) into a
//   first-class production backend, so the native standalone app no longer
//   needs Docker + PostgREST. PGlite is single-connection by design — every
//   call gets serialized through one promise queue.
//
// Surface intentionally narrow: only the verbs services in src/services/
// actually call. Adding a verb is a few lines; aiming for full PostgREST
// parity would be expensive scaffolding for behavior nothing exercises.

import type { PGlite } from "@electric-sql/pglite";

export interface AdapterError {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

export interface AdapterResult<T> {
  data: T | null;
  error: AdapterError | null;
}

type FilterOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in";
interface Filter {
  op: FilterOp | "or";
  col?: string;
  val?: unknown;
  raw?: string;
}

type Action =
  | { kind: "select"; cols: string }
  | { kind: "insert"; values: Record<string, unknown>[]; returning: string | null }
  | { kind: "update"; values: Record<string, unknown>; returning: string | null }
  | { kind: "delete"; returning: string | null };

type Single = "single" | "maybe" | null;

interface OrderClause {
  col: string;
  ascending: boolean;
  nullsFirst?: boolean;
}

// PGlite's type for query() — kept loose to avoid pinning to a private surface.
interface PgLikeRow extends Record<string, unknown> {}
interface PgLikeResult {
  rows: PgLikeRow[];
}
type PgQueryFn = (sql: string, params?: unknown[]) => Promise<PgLikeResult>;

export class QueryBuilder<T = unknown> implements PromiseLike<AdapterResult<T>> {
  private action: Action | null = null;
  private filters: Filter[] = [];
  private orders: OrderClause[] = [];
  private limitN: number | null = null;
  private singleMode: Single = null;

  constructor(
    private readonly table: string,
    private readonly run: PgQueryFn,
  ) {}

  // Used by buildSql / filterToSql via the closure passed below — keeps the
  // value-vs-cast unwrapping in one place so a stray `params.push(serializeValue(x))`
  // can't reintroduce the "could not determine data type of parameter $N" failure.
  private pushParam(params: unknown[], v: unknown): string {
    const s = serializeValue(v);
    params.push(s.value);
    return s.cast ? `$${params.length}::${s.cast}` : `$${params.length}`;
  }

  // -- actions ------------------------------------------------------------

  select(cols: string = "*"): this {
    if (this.action && this.action.kind !== "select") {
      // select() chained after insert/update/delete → RETURNING clause.
      this.action.returning = cols;
      return this;
    }
    this.action = { kind: "select", cols };
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    const rows = Array.isArray(values) ? values : [values];
    this.action = { kind: "insert", values: rows, returning: null };
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.action = { kind: "update", values, returning: null };
    return this;
  }

  delete(): this {
    this.action = { kind: "delete", returning: null };
    return this;
  }

  // -- filters ------------------------------------------------------------

  eq(col: string, val: unknown): this { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: unknown): this { this.filters.push({ op: "neq", col, val }); return this; }
  gt(col: string, val: unknown): this { this.filters.push({ op: "gt", col, val }); return this; }
  gte(col: string, val: unknown): this { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown): this { this.filters.push({ op: "lt", col, val }); return this; }
  lte(col: string, val: unknown): this { this.filters.push({ op: "lte", col, val }); return this; }
  in(col: string, vals: readonly unknown[]): this {
    this.filters.push({ op: "in", col, val: vals });
    return this;
  }

  /**
   * PostgREST-style "or" filter — accepts a comma-separated string of
   * `col.op.val,col.op.val` clauses (matching what the services in
   * `src/services/identity.ts` already pass). This adapter understands
   * the small subset our codebase actually uses (`eq`, `lt`, `gt`,
   * `lte`, `gte`, `neq`). Anything else throws — failing fast beats
   * silently dropping a clause.
   */
  or(filterString: string): this {
    const parts = splitOrClauses(filterString);
    const sqlParts = parts.map((p) => orClauseToSql(p));
    this.filters.push({ op: "or", raw: `(${sqlParts.join(" OR ")})` });
    return this;
  }

  // -- modifiers ----------------------------------------------------------

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({
      col,
      ascending: opts?.ascending ?? true,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }

  limit(n: number): this { this.limitN = n; return this; }

  single(): this { this.singleMode = "single"; return this; }
  maybeSingle(): this { this.singleMode = "maybe"; return this; }

  // -- thenable -----------------------------------------------------------

  then<TR1 = AdapterResult<T>, TR2 = never>(
    onfulfilled?: ((value: AdapterResult<T>) => TR1 | PromiseLike<TR1>) | null,
    onrejected?: ((reason: unknown) => TR2 | PromiseLike<TR2>) | null,
  ): PromiseLike<TR1 | TR2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<AdapterResult<T>> {
    if (!this.action) {
      return errResult("no action specified", "MYC_PGLITE_NO_ACTION");
    }
    try {
      const { sql, params } = this.buildSql();
      const result = await this.run(sql, params);
      return shapeResult<T>(result.rows, this.action, this.singleMode);
    } catch (err) {
      return errResult(formatError(err), "MYC_PGLITE_QUERY_ERROR");
    }
  }

  private buildSql(): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const push = (v: unknown) => this.pushParam(params, v);
    const action = this.action!;
    const tbl = quoteIdent(this.table);
    let sql = "";

    if (action.kind === "select") {
      sql = `SELECT ${action.cols} FROM ${tbl}`;
    } else if (action.kind === "insert") {
      if (action.values.length === 0) {
        throw new Error("insert(): empty value list");
      }
      // Union of column sets across all rows. PostgREST treats a heterogeneous
      // bulk insert as union-with-NULL-for-absent; taking keys from row 0 only
      // would silently drop columns that appear in later rows.
      const colSet = new Set<string>();
      for (const row of action.values) {
        for (const k of Object.keys(row)) colSet.add(k);
      }
      const cols = [...colSet];
      const colsSql = cols.map(quoteIdent).join(", ");
      const rowsSql = action.values
        .map((row) => {
          const vals = cols.map((c) =>
            Object.prototype.hasOwnProperty.call(row, c) ? push(row[c]) : "DEFAULT",
          );
          return `(${vals.join(", ")})`;
        })
        .join(", ");
      sql = `INSERT INTO ${tbl} (${colsSql}) VALUES ${rowsSql}`;
    } else if (action.kind === "update") {
      const cols = Object.keys(action.values);
      const setSql = cols
        .map((c) => `${quoteIdent(c)} = ${push(action.values[c])}`)
        .join(", ");
      sql = `UPDATE ${tbl} SET ${setSql}`;
    } else if (action.kind === "delete") {
      sql = `DELETE FROM ${tbl}`;
    }

    if (this.filters.length > 0) {
      const whereSql = this.filters
        .map((f) => filterToSql(f, push))
        .join(" AND ");
      sql += ` WHERE ${whereSql}`;
    }

    if (action.kind === "select") {
      if (this.orders.length > 0) {
        sql += ` ORDER BY ${this.orders.map(orderToSql).join(", ")}`;
      }
      if (this.limitN !== null) {
        sql += ` LIMIT ${this.limitN}`;
      }
    }

    if (action.kind !== "select") {
      const ret = action.returning;
      if (ret !== null) {
        sql += ` RETURNING ${ret || "*"}`;
      }
    }

    return { sql, params };
  }
}

function shapeResult<T>(
  rows: PgLikeRow[],
  action: Action,
  singleMode: Single,
): AdapterResult<T> {
  const isWriteWithoutReturning =
    action.kind !== "select" && action.kind && (action as { returning: string | null }).returning === null;

  if (isWriteWithoutReturning) {
    return { data: null, error: null };
  }

  if (singleMode === "single") {
    if (rows.length === 0) {
      return {
        data: null,
        error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" },
      };
    }
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: "more than one row returned by single()", code: "PGRST116" },
      };
    }
    return { data: rows[0] as T, error: null };
  }

  if (singleMode === "maybe") {
    if (rows.length === 0) return { data: null, error: null };
    if (rows.length > 1) {
      return {
        data: null,
        error: { message: "more than one row returned by maybeSingle()", code: "PGRST116" },
      };
    }
    return { data: rows[0] as T, error: null };
  }

  return { data: rows as unknown as T, error: null };
}

function filterToSql(
  f: Filter,
  push: (v: unknown) => string,
): string {
  if (f.op === "or" && f.raw) return f.raw;
  if (!f.col) throw new Error(`filter has no column: ${f.op}`);
  const col = quoteIdent(f.col);
  if (f.op === "in") {
    const arr = (f.val as unknown[]) ?? [];
    if (arr.length === 0) {
      // Postgres rejects empty IN(); produce always-false predicate to match
      // PostgREST's "no match" semantics.
      return "FALSE";
    }
    const placeholders = arr.map((v) => push(v));
    return `${col} IN (${placeholders.join(", ")})`;
  }
  const opSql: Record<FilterOp, string> = {
    eq: "=",
    neq: "<>",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
    in: "IN",
  };
  return `${col} ${opSql[f.op as FilterOp]} ${push(f.val)}`;
}

function orderToSql(o: OrderClause): string {
  let s = `${quoteIdent(o.col)} ${o.ascending ? "ASC" : "DESC"}`;
  if (o.nullsFirst === true) s += " NULLS FIRST";
  else if (o.nullsFirst === false) s += " NULLS LAST";
  return s;
}

function splitOrClauses(s: string): string[] {
  // Accepts `col.op.val,col.op.val` and respects parens for nested groups
  // (we don't actually use them today; this is forward-protection).
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function orClauseToSql(clause: string): string {
  const m = clause.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([a-z]+)\.(.+)$/);
  if (!m) throw new Error(`unsupported or() clause: ${clause}`);
  const [, col, op, raw] = m;
  const map: Record<string, string> = {
    eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=",
  };
  const sqlOp = map[op];
  if (!sqlOp) throw new Error(`unsupported or() operator: ${op}`);
  const lit = parseOrLiteral(raw);
  return `${quoteIdent(col)} ${sqlOp} ${lit}`;
}

function parseOrLiteral(raw: string): string {
  // PostgREST or() clauses are urlencoded; our one in-tree caller passes
  // literal numerics and string enums so the inline-literal path is enough.
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  return `'${raw.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return `"${name}"`;
}

interface SerializedParam {
  value: unknown;
  /** Optional explicit Postgres cast (e.g. "jsonb", "vector"). PGlite is
   *  stricter than PostgREST about parameter typing — strings need an
   *  explicit cast when the column is JSONB or VECTOR. */
  cast: string | null;
}

function serializeValue(v: unknown): SerializedParam {
  if (v === undefined || v === null) return { value: null, cast: null };
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every((x) => typeof x === "number")) {
      // pgvector textual form — handles our VECTOR(N) embedding columns.
      return { value: `[${v.join(",")}]`, cast: "vector" };
    }
    if (v.length > 0 && v.every((x) => typeof x === "string")) {
      // TEXT[] columns (e.g. memories.tags). Postgres array literal:
      // {"a","b"}. We escape per the array_in() rules.
      return { value: encodeTextArray(v as string[]), cast: "text[]" };
    }
    // Empty / mixed / structured arrays route through JSONB. Empty arrays
    // would also satisfy a TEXT[] column, but TEXT[] vs JSONB ambiguity
    // for `[]` is unresolvable without column metadata; we side with JSONB
    // because every TEXT[] column in the schema (`tags`, `tools_used`)
    // also accepts NULL/`{}`-as-empty, while JSONB is the more common shape.
    return { value: JSON.stringify(v), cast: "jsonb" };
  }
  if (typeof v === "object") {
    return { value: JSON.stringify(v), cast: "jsonb" };
  }
  return { value: v, cast: null };
}

function encodeTextArray(items: string[]): string {
  // Postgres array literal: `{"a","b"}` with embedded `"` and `\` escaped.
  const parts = items.map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `{${parts.join(",")}}`;
}

function pushParam(params: unknown[], v: unknown): string {
  const s = serializeValue(v);
  params.push(s.value);
  return s.cast ? `$${params.length}::${s.cast}` : `$${params.length}`;
}

function formatError(err: unknown): string {
  if (!err) return "unknown";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return JSON.stringify(err);
}

function errResult<T>(message: string, code: string): AdapterResult<T> {
  return { data: null, error: { message, code } };
}

/**
 * PGlite adapter — single in-process instance with a serialized op queue.
 *
 * Concurrency model: PGlite is single-connection. If two services kick off
 * parallel queries, libpglite serializes them anyway (last write wins on the
 * shared cursor). We make that explicit with a Promise chain, so every adapter
 * call observes the database in a deterministic order.
 */
export class PGliteAdapter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly pg: PGlite) {}

  /** Underlying PGlite handle — escape hatch for migrations / debugging. */
  raw(): PGlite { return this.pg; }

  from<T = unknown>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table, (sql, params) => this.run(sql, params));
  }

  async rpc<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<AdapterResult<T>> {
    const argNames = Object.keys(args);
    const params: unknown[] = [];
    const argSql = argNames
      .map((n) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) {
          throw new Error(`unsafe RPC arg name: ${n}`);
        }
        return `${n} := ${pushParam(params, args[n])}`;
      })
      .join(", ");
    const sql = `SELECT * FROM ${quoteIdent(name)}(${argSql})`;
    try {
      const result = await this.run(sql, params);
      // Functions returning a scalar collapse `{ "<name>": value }` to value;
      // table-returning functions surface row arrays directly. We follow the
      // PostgREST convention: scalars unwrap, sets stay as arrays.
      const rows = result.rows as Array<Record<string, unknown>>;
      if (rows.length === 0) return { data: null, error: null };
      if (rows.length === 1 && Object.keys(rows[0]).length === 1 && Object.prototype.hasOwnProperty.call(rows[0], name)) {
        return { data: rows[0][name] as T, error: null };
      }
      return { data: rows as unknown as T, error: null };
    } catch (err) {
      return errResult(formatError(err), "MYC_PGLITE_RPC_ERROR");
    }
  }

  private run(sql: string, params: unknown[] = []): Promise<PgLikeResult> {
    const next = this.queue.then(async () => {
      // PGlite's query() resolves to `{ rows, fields, ... }`. Casting via
      // unknown silences the structural mismatch with our minimal interface.
      return (await this.pg.query(sql, params)) as unknown as PgLikeResult;
    });
    // Keep the chain alive even on failure so subsequent ops don't reject
    // synchronously through the queue itself.
    this.queue = next.catch(() => undefined);
    return next;
  }
}
