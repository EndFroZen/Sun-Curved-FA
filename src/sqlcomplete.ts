// SQL autocomplete brains (no CodeMirror here, so it's testable): what fits at the cursor, given the statement.

export type Ref = { table: string; alias: string };
export type Ctx = "table" | "column" | "on" | "after" | "start" | "none";

const KW = new Set(("select from where join left right inner outer full cross natural on using and or not group order by having limit offset " +
  "union all set values into update delete insert as distinct case when then else end is null in like ilike between exists asc desc " +
  "returning with create table alter drop index view truncate describe desc explain show straight_join lateral").split(" "));

type Tok = { t: string; low: string; q: boolean }; // q = was quoted
/** Identifiers (quotes stripped), numbers and punctuation; strings and comments dropped. */
export function tokens(sql: string): Tok[] {
  const out: Tok[] = [];
  const re = /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'?|"((?:[^"]|"")*)"?|`((?:[^`]|``)*)`?|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|(<=|>=|<>|!=|::|[(),.;*=<>+\-/%])/g;
  for (const m of sql.matchAll(re)) {
    const q = m[1] ?? m[2];
    if (q !== undefined) out.push({ t: q, low: q.toLowerCase(), q: true });
    else if (m[3] || m[4] || m[5]) { const t = m[3] ?? m[4] ?? m[5]; out.push({ t, low: t.toLowerCase(), q: false }); }
  }
  return out;
}
const isIdent = (k: Tok | undefined) => !!k && (k.q || (/^[A-Za-z_$]/.test(k.t) && !KW.has(k.low)));

/** Tables a statement reads or writes, with their aliases: FROM a x, b AS y JOIN c ON … / UPDATE d / INSERT INTO e. */
export function refsIn(sql: string): Ref[] {
  const ts = tokens(sql), out: Ref[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (!["from", "join", "update", "into"].includes(ts[i].low)) continue;
    let j = i + 1;
    do {
      if (ts[j]?.t === ",") j++;
      if (!isIdent(ts[j])) break;
      let table = ts[j++].t;
      while (ts[j]?.t === "." && isIdent(ts[j + 1])) table = ts[(j += 2) - 1].t; // schema.table -> table
      if (ts[j]?.low === "as") j++;
      const alias = isIdent(ts[j]) ? ts[j++].t : "";
      out.push({ table, alias });
    } while (ts[i].low === "from" && ts[j]?.t === ",");
  }
  return out;
}

/** What belongs at the end of `before` (the statement text up to the word being typed). */
export function contextAt(before: string): Ctx {
  if (insideText(before)) return "none";
  const ts = tokens(before);
  const last = ts[ts.length - 1];
  if (!last) return "start";
  // nearest clause keyword decides what a comma continues
  let clause = "";
  for (let i = ts.length - 1; i >= 0 && !clause; i--) if (["select", "from", "join", "where", "on", "by", "having", "set", "values", "update", "into"].includes(ts[i].low)) clause = ts[i].low;
  const l = last.low;
  if (["from", "join", "update", "into", "table", "truncate", "describe"].includes(l)) return "table";
  if (l === "on") return "on";
  if (l === ",") return clause === "from" ? "table" : "column";
  if (["select", "where", "and", "or", "not", "by", "having", "set", "when", "then", "else", "distinct", "(", "=", "<", ">", "<=", ">=", "<>", "!=", "+", "-", "*", "/", "%", "in", "like", "ilike", "between", "is", "case", "using", "returning"].includes(l)) return "column";
  return "after"; // right after a name or value: next keyword (WHERE, JOIN, AS, =, …)
}

/** True when `before` ends inside a string literal or a comment (no suggestions there). */
function insideText(before: string) {
  let open = false;
  for (const m of before.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|\/\*[\s\S]*$|'(?:[^']|'')*'|'(?:[^']|'')*$/g)) {
    const s = m[0];
    open = m.index! + s.length === before.length &&
      (s.startsWith("--") || (s.startsWith("/*") && !/^\/\*[\s\S]*\*\/$/.test(s)) || (s.startsWith("'") && !/^'(?:[^']|'')*'$/.test(s)));
  }
  return open;
}

/** `a.x = b.x` conditions for the table just joined against the ones before it: same column name, or `<table>_id` -> `id`. */
export function joinConds(refs: Ref[], cols: (t: string) => string[]): string[] {
  const last = refs[refs.length - 1];
  if (!last || refs.length < 2) return [];
  const name = (r: Ref) => r.alias || r.table;
  const lc = cols(last.table), out: string[] = [];
  for (const r of refs.slice(0, -1)) {
    const rc = cols(r.table);
    for (const c of lc) {
      if (rc.includes(c) && c !== "id") out.push(`${name(last)}.${c} = ${name(r)}.${c}`);
      if (c === `${r.table}_id` && rc.includes("id")) out.push(`${name(last)}.${c} = ${name(r)}.id`);
    }
    for (const c of rc) if (c === `${last.table}_id` && lc.includes("id")) out.push(`${name(last)}.id = ${name(r)}.${c}`);
  }
  return [...new Set(out)];
}

export const FUNCS: Record<string, string[]> = {
  all: "COUNT SUM AVG MIN MAX COALESCE NULLIF CAST LOWER UPPER TRIM LENGTH SUBSTRING REPLACE ROUND ABS CONCAT".split(" "),
  postgres: "NOW CURRENT_DATE DATE_TRUNC EXTRACT TO_CHAR TO_DATE AGE STRING_AGG ARRAY_AGG JSON_AGG JSONB_BUILD_OBJECT GENERATE_SERIES ILIKE REGEXP_REPLACE SPLIT_PART ROW_NUMBER RANK LAG LEAD".split(" "),
  mysql: "NOW CURDATE CURTIME DATE DATE_FORMAT DATE_ADD DATE_SUB DATEDIFF TIMESTAMPDIFF YEAR MONTH DAY IFNULL IF GROUP_CONCAT CONCAT_WS LEFT RIGHT LPAD JSON_EXTRACT ROW_NUMBER RANK LAG LEAD".split(" "),
  sqlite: "DATE DATETIME TIME STRFTIME JULIANDAY IFNULL IIF GROUP_CONCAT INSTR PRINTF TYPEOF JSON_EXTRACT ROW_NUMBER".split(" "),
};
/** Keywords worth offering next, by context. */
export const NEXT_KW: Record<Ctx, string[]> = {
  start: ["SELECT", "INSERT INTO", "UPDATE", "DELETE FROM", "WITH", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "EXPLAIN", "SHOW TABLES", "DESCRIBE"],
  after: ["FROM", "WHERE", "AND", "OR", "AS", "JOIN", "LEFT JOIN", "INNER JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION ALL",
    "IS NULL", "IS NOT NULL", "IN", "NOT IN", "LIKE", "BETWEEN", "ASC", "DESC", "SET", "VALUES", "RETURNING", "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END"],
  column: ["DISTINCT", "CASE", "NOT", "EXISTS", "NULL", "TRUE", "FALSE"],
  table: [],
  on: [],
  none: [],
};
