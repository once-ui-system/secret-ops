/**
 * Just enough SQL lexing to split a migration into top-level statements:
 * quotes, comments and dollar-quoted bodies (plpgsql BEGIN ... END) are
 * skipped, so a `begin` inside a function never counts as a statement.
 */
export function splitStatements(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") (depth++, (i += 2));
        else if (sql[i] === "*" && sql[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === c && sql[i + 1] === c) i += 2;
        else if (sql[i] === c) break;
        else i++;
      }
      i++;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
        const end = sql.indexOf(m[0], i + m[0].length);
        i = end === -1 ? n : end + m[0].length;
      } else i++;
    } else if (c === ";") {
      out.push(sql.slice(start, i + 1));
      i++;
      start = i;
    } else i++;
  }
  if (sql.slice(start).trim()) out.push(sql.slice(start));
  return out.filter((s) => stripComments(s).trim() !== "" && stripComments(s).trim() !== ";");
}

function stripComments(s) {
  return s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The statement's first words, lowercased, comments removed. */
export function head(stmt) {
  return stripComments(stmt).trim().replace(/;$/, "").trim().toLowerCase().replace(/\s+/g, " ");
}

const TXN = /^(begin|start transaction|commit|end|rollback|abort|savepoint|release|prepare transaction|commit prepared|rollback prepared)\b/;
const NO_TXN = [
  [/\bconcurrently\b/, "uses CONCURRENTLY, which can't run inside a transaction"],
  [/^vacuum\b/, "runs VACUUM, which can't run inside a transaction"],
  [/^(create|drop) database\b/, "creates or drops a database"],
  [/^alter system\b/, "runs ALTER SYSTEM"],
];

/**
 * Makes a migration safe to run inside our own transaction. A file that wraps
 * itself in BEGIN ... COMMIT has the wrapper removed (our transaction does the
 * same job). Any other transaction control, or a statement that can't run in
 * a transaction, is refused: we could neither rehearse it nor roll it back.
 */
export function prepareMigration(sql) {
  const stmts = splitStatements(sql);
  const heads = stmts.map(head);
  let from = 0;
  let to = stmts.length;
  if (/^(begin|start transaction)\b/.test(heads[0] ?? "") && /^(commit|end)\b/.test(heads[to - 1] ?? "")) {
    from = 1;
    to -= 1;
  }
  const problems = [];
  for (let k = from; k < to; k++) {
    if (TXN.test(heads[k])) problems.push(`statement ${k + 1} is transaction control (${heads[k].split(" ")[0]})`);
    for (const [re, why] of NO_TXN) if (re.test(heads[k])) problems.push(`statement ${k + 1} ${why}`);
  }
  return { sql: stmts.slice(from, to).join("\n"), statements: to - from, problems };
}

/** A SQL string literal. Only used for paths, hashes and URLs we produce. */
export function lit(v) {
  return v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`;
}

const SQLSTATE_NAMES = {
  "42601": "syntax_error",
  "42501": "insufficient_privilege",
  "42P01": "undefined_table",
  "42703": "undefined_column",
  "42704": "undefined_object",
  "42883": "undefined_function",
  "3F000": "invalid_schema_name",
  "42P06": "duplicate_schema",
  "42P07": "duplicate_table",
  "42701": "duplicate_column",
  "42710": "duplicate_object",
  "42723": "duplicate_function",
  "42P16": "invalid_table_definition",
  "42804": "datatype_mismatch",
  "22P02": "invalid_text_representation",
  "23502": "not_null_violation",
  "23503": "foreign_key_violation",
  "23505": "unique_violation",
  "23514": "check_violation",
  "2BP01": "dependent_objects_still_exist",
  "25001": "active_sql_transaction",
  "40P01": "deadlock_detected",
  "55P03": "lock_not_available",
  "57014": "query_canceled",
};

/**
 * What a failed query may say in this public repo's logs: the HTTP status and
 * the Postgres error code with its condition name. Postgres's own message
 * names tables, columns and policies and can quote the SQL (its LINE n: echo),
 * and the source repos are private, so the message itself is never printed.
 * Read the full text by running the file in the SQL editor or a local copy.
 */
export function publicSqlError(message) {
  const text = String(message ?? "");
  const status = /->\s*(\d{3})\b/.exec(text)?.[1];
  const code = /\b(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/.exec(text)?.[1] ?? /\b(?:SQLSTATE|code)[\s:=]+"?([0-9A-Z]{5})\b/i.exec(text)?.[1];
  const parts = [];
  if (code) parts.push(`Postgres error ${code}${SQLSTATE_NAMES[code] ? ` (${SQLSTATE_NAMES[code]})` : ""}`);
  else parts.push("Postgres error (no error code in the response)");
  if (status) parts.push(`HTTP ${status}`);
  return `${parts.join(", ")}; the message is not shown in this public log`;
}
