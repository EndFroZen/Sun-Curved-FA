// BaseCurves: SQL builders for the table editor (SQLite, PostgreSQL, MySQL/MariaDB).
// SQLite rows are addressed by rowid; the others by primary key (no PK = read-only grid).

export type Dialect = "sqlite" | "postgres" | "mysql";
export type Col = { name: string; type: string; pk: boolean | number };

/** Input → plugin URL. `postgresql://` and `mariadb://` are aliases; anything else is a SQLite file path. */
export function connUrl(s: string): { url: string; d: Dialect } {
  s = s.trim();
  if (/^postgres(ql)?:\/\//i.test(s)) return { url: noDb(s.replace(/^postgres(ql)?:/i, "postgres:"), "postgres"), d: "postgres" };
  if (/^(mysql|mariadb):\/\//i.test(s)) return { url: noDb(s.replace(/^(mysql|mariadb):/i, "mysql:"), "information_schema"), d: "mysql" };
  return { url: s.startsWith("sqlite:") ? s : `sqlite:${s}`, d: "sqlite" };
}

/** No database in the URL: connect to one that always exists, then pick from the database list. */
const noDb = (s: string, fallback: string) => (new URL(s).pathname.length > 1 ? s : withDb(s, fallback));

/** Quote an identifier: "a""b" (MySQL: `a``b`). */
export const qid = (d: Dialect, s: string) => (d === "mysql" ? `\`${s.replace(/`/g, "``")}\`` : `"${s.replace(/"/g, '""')}"`);

/** Placeholder n. Postgres params are sent as text and cast to the column type, so int/uuid/date columns accept them. */
const ph = (d: Dialect, n: number, type = "") => (d === "mysql" ? "?" : d === "postgres" && type ? `CAST($${n} AS ${type})` : `$${n}`);
export const arg = (d: Dialect, v: unknown) => (d === "postgres" && v !== null ? String(v) : v);

export const tablesSql = (d: Dialect) =>
  d === "sqlite" ? "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  : d === "postgres" ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1"
  : "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1";

/** One table's columns: name, type, nullable, default, pk (MySQL adds extra). Returns [sql, args]. */
export const structSql = (d: Dialect, t: string): [string, unknown[]] =>
  d === "sqlite" ? [`SELECT name, type, NOT "notnull" AS nullable, dflt_value AS "default", pk FROM pragma_table_info($1)`, [t]]
  : d === "postgres"
    ? [`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_get_expr(ad.adbin, ad.adrelid) AS "default",
        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
       FROM pg_attribute a LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
       WHERE a.attrelid = CAST($1 AS regclass) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [qid(d, t)]]
    : ["SELECT column_name AS name, column_type AS type, is_nullable = 'YES' AS nullable, column_default AS `default`, column_key = 'PRI' AS pk, extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [t]];

/** One table's indexes. Returns [sql, args]. */
export const indexSql = (d: Dialect, t: string): [string, unknown[]] =>
  d === "sqlite" ? [`SELECT il.name, il."unique", group_concat(ii.name, ', ') AS columns FROM pragma_index_list($1) il JOIN pragma_index_info(il.name) ii GROUP BY il.name`, [t]]
  : d === "postgres" ? ["SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 ORDER BY 1", [t]]
  : ["SELECT index_name AS name, NOT non_unique AS `unique`, GROUP_CONCAT(column_name ORDER BY seq_in_index SEPARATOR ', ') AS columns FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? GROUP BY index_name, non_unique", [t]];

/** Every foreign key in the current database/schema: rows of { t, c, rt, rc } (SQLite rc may be null = the target's PK). */
export const fksSql = (d: Dialect) =>
  d === "sqlite" ? `SELECT m.name AS t, f."from" AS c, f."table" AS rt, f."to" AS rc FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f WHERE m.type = 'table'`
  : d === "postgres"
    ? `SELECT cl.relname AS t, a.attname AS c, rcl.relname AS rt, ra.attname AS rc
       FROM pg_constraint k JOIN pg_class cl ON cl.oid = k.conrelid JOIN pg_class rcl ON rcl.oid = k.confrelid
       CROSS JOIN LATERAL unnest(k.conkey, k.confkey) AS u(a1, a2)
       JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.a1
       JOIN pg_attribute ra ON ra.attrelid = k.confrelid AND ra.attnum = u.a2
       WHERE k.contype = 'f' AND cl.relnamespace = current_schema()::regnamespace`
    : "SELECT table_name AS t, column_name AS c, referenced_table_name AS rt, referenced_column_name AS rc FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL";

// ponytail: WITHOUT ROWID SQLite tables can't be edited here; use the SQL box.
export type Sort = { col: string; desc: boolean } | null;
/** Raw WHERE text from the filter box ("WHERE" prefix optional); the user already runs arbitrary SQL here. */
const whereOf = (w = "") => ((w = w.trim().replace(/^where\s+/i, "")) ? ` WHERE ${w}` : "");
export const selectSql = (d: Dialect, t: string, o: { where?: string; sort?: Sort; limit?: number; offset?: number } = {}) =>
  `SELECT ${d === "sqlite" ? "rowid AS __rowid, " : ""}* FROM ${qid(d, t)}${whereOf(o.where)}${o.sort ? ` ORDER BY ${qid(d, o.sort.col)}${o.sort.desc ? " DESC" : ""}` : ""} LIMIT ${o.limit ?? 500}${o.offset ? ` OFFSET ${o.offset}` : ""}`;
export const countSql = (d: Dialect, t: string, where = "") => `SELECT COUNT(*) AS n FROM ${qid(d, t)}${whereOf(where)}`;
export const truncateSql = (d: Dialect, t: string) => (d === "sqlite" ? `DELETE FROM ${qid(d, t)}` : `TRUNCATE TABLE ${qid(d, t)}`);

/** A column in the New Table form. `def` is a raw SQL expression ('text', 0, CURRENT_TIMESTAMP). */
/** `ref` = foreign key to table `t`, column `c`. */
export type Ref = { t: string; c: string };
export type NewCol = { name: string; type: string; pk: boolean; nn: boolean; auto: boolean; def: string; uniq?: boolean; ref?: Ref };

/** Codeless New Table: plain-language column kinds → SQL type per dialect [sqlite, postgres, mysql]. */
export const KINDS = {
  text: ["Text", "TEXT", "varchar(255)", "VARCHAR(255)"],
  long: ["Long text", "TEXT", "text", "TEXT"],
  int: ["Number", "INTEGER", "integer", "INT"],
  dec: ["Decimal / money", "NUMERIC", "numeric(12,2)", "DECIMAL(12,2)"],
  // SQLite: descriptive names (any name is legal there) so Verify can read the kind back
  bool: ["Yes / No", "BOOLEAN", "boolean", "TINYINT(1)"],
  date: ["Date", "DATE", "date", "DATE"],
  time: ["Date & time", "DATETIME", "timestamptz", "DATETIME"],
  json: ["JSON", "JSON", "jsonb", "JSON"],
} as const;
export type ColKind = keyof typeof KINDS;
export const kindType = (d: Dialect, k: ColKind) => KINDS[k][d === "sqlite" ? 1 : d === "postgres" ? 2 : 3];
/** "First Name" → "first_name" (letters incl. marks such as Thai vowels/tones, digits, _ only). */
export const slug = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
/** A plain default typed by the user ("hello", 5, yes, now) → SQL literal; "" = no default. */
export function defSql(d: Dialect, k: ColKind, v: string): string {
  v = v.trim();
  if (!v) return "";
  if ((k === "date" || k === "time") && /^(now|today|ตอนนี้|วันนี้)$/i.test(v))
    return k === "time" ? "CURRENT_TIMESTAMP" : d === "mysql" ? "(CURRENT_DATE)" : "CURRENT_DATE";
  if (k === "bool") { const y = /^(yes|y|true|1|on|ใช่)$/i.test(v); return d === "postgres" ? (y ? "TRUE" : "FALSE") : y ? "1" : "0"; }
  if ((k === "int" || k === "dec") && /^-?\d+(\.\d+)?$/.test(v)) return v;
  const lit = `'${v.replace(/'/g, "''")}'`;
  return d === "mysql" && (k === "long" || k === "json") ? `(${lit})` : lit; // MySQL: TEXT/JSON only take expression defaults
}
/** SQL type → designer kind (null = the designer has no kind for it). */
export function kindOfType(d: Dialect, t: string): ColKind | null {
  t = t.toLowerCase().trim();
  if (/^(tinyint\(1\)|bool)/.test(t)) return "bool";
  if (/^(tiny|small|medium|big)?int(eger|\d)?\b|^(small|big)?serial\b/.test(t)) return "int";
  if (/^(numeric|decimal|real|double|float|money)/.test(t)) return "dec";
  if (/^(timestamp|datetime)/.test(t)) return "time";
  if (/^date$/.test(t)) return "date";
  if (/^json/.test(t)) return "json";
  if (/char/.test(t)) return "text";
  if (/^(tiny|medium|long)?text$|^clob$/.test(t)) return d === "sqlite" ? "text" : "long";
  return null;
}
export type DraftCol = { name: string; kind: ColKind; pk: boolean; nn: boolean; auto: boolean; def: string; uniq: boolean; ref?: Ref };
const REF = String.raw`references\s+("(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\p{L}\p{N}_.]+)\s*(?:\(([^),]*)\))?`;
/** SQL default literal → the plain value the designer shows (inverse of defSql). */
function defPlain(k: ColKind, v: string) {
  v = v.trim();
  if (/^null$/i.test(v)) return "";
  if (/^\(?\s*(current_timestamp|current_date|now\(\))\s*\)?$/i.test(v)) return "now";
  v = v.replace(/^\(([\s\S]*)\)$/, "$1").trim(); // MySQL expression default ('x')
  if (k === "bool") return /^(true|1|'1'|'t')$/i.test(v) ? "yes" : "no";
  const m = /^'([\s\S]*)'(::[\w ]+)?$/.exec(v);
  return m ? m[1].replace(/''/g, "'") : v;
}
const STOP = String.raw`not|null|default|primary|generated|auto_increment|autoincrement|unique|references|check|constraint|collate|unsigned`;
/** Edited CREATE TABLE → table name + designer columns. Throws a readable Error for anything the designer can't show. */
export function parseCreate(d: Dialect, sql: string): { table: string; cols: DraftCol[] } {
  sql = sql.replace(/('(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`)|--[^\n]*|\/\*[\s\S]*?\*\//g, (_, q) => q ?? " "); // drop comments, keep quoted text
  const m = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?("(?:[^"]|"")*"|`(?:[^`]|``)*`|[\p{L}\p{N}_.]+)\s*\(([\s\S]*)\)\s*;?\s*$/iu.exec(sql);
  if (!m) throw new Error("Expected: CREATE TABLE name ( column type, … )");
  const table = unq(d, /^["`]/.test(m[1]) ? m[1] : m[1].split(".").pop()!);
  const cols: DraftCol[] = [], tablePk: string[] = [], tableUq: string[] = [], tableFk: [string, Ref][] = [];
  const ref = (t: string, c?: string): Ref => ({ t: unq(d, /^["`]/.test(t) ? t : t.split(".").pop()!), c: c ? unq(d, c.trim()) : "id" });
  for (const part of splitTop(m[2]).filter(Boolean)) {
    const fk = new RegExp(String.raw`^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^),]*)\)\s*${REF}`, "iu").exec(part); // single-column FK only
    if (fk) { tableFk.push([unq(d, fk[1].trim()), ref(fk[2], fk[3])]); continue; }
    const pk = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)$/i.exec(part);
    if (pk) { tablePk.push(...pk[1].split(",").map((s) => unq(d, s.trim()))); continue; }
    const uq = /^(?:constraint\s+\S+\s+)?unique\s*(?:key\s*)?\(([^),]*)\)$/i.exec(part); // single-column UNIQUE only
    if (uq) { tableUq.push(unq(d, uq[1].trim())); continue; }
    if (/^(constraint|foreign|unique|check|key|index)\b/i.test(part)) throw new Error(`Not supported in the designer: ${part.split(/\s+/).slice(0, 3).join(" ")}… — use Open in Query`);
    const c = new RegExp(String.raw`^("(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|[\p{L}\p{N}_]+)\s+([\p{L}\p{N}_ ]+?(?:\s*\([^)]*\))?)(?=\s+(?:${STOP})\b|\s*$)([\s\S]*)$`, "iu").exec(part);
    if (!c) throw new Error(`Can't read column: ${part}`);
    const [, rawName, type, rest] = c, name = unq(d, rawName);
    const bare = rest.replace(/'(?:[^']|'')*'/g, "''"); // keywords inside a quoted default don't count
    const kind = kindOfType(d, type);
    if (!kind) throw new Error(`${name}: type "${type.trim()}" has no kind here (Text, Number, Decimal, Yes/No, Date, Date & time, JSON)`);
    if (/\bcheck\b/i.test(bare)) throw new Error(`${name}: CHECK isn't supported in the designer — use Open in Query`);
    const def = /(?<!\bby\s+)\bdefault\s+('(?:[^']|'')*'(?:::[\w ]+)?|\([^)]*\)|[^\s,]+)/i.exec(rest)?.[1] ?? "";
    const r = new RegExp(REF, "iu").exec(bare);
    cols.push({ name, kind, pk: /\bprimary\s+key\b/i.test(bare), nn: /\bnot\s+null\b/i.test(bare),
      auto: /\b(auto_increment|autoincrement|identity)\b/i.test(bare) || /serial/i.test(type), def: def ? defPlain(kind, def) : "", uniq: /\bunique\b/i.test(bare),
      ...(r ? { ref: ref(r[1], r[2]) } : {}) });
  }
  if (!cols.length) throw new Error("No columns");
  for (const [n, r] of tableFk) { const c = cols.find((x) => x.name === n); if (!c) throw new Error(`FOREIGN KEY names unknown column ${n}`); c.ref = r; }
  for (const n of tablePk) { const c = cols.find((x) => x.name === n); if (!c) throw new Error(`PRIMARY KEY names unknown column ${n}`); c.pk = true; }
  for (const n of tableUq) { const c = cols.find((x) => x.name === n); if (!c) throw new Error(`UNIQUE names unknown column ${n}`); c.uniq = true; }
  const pks = cols.filter((c) => c.pk);
  if (d === "sqlite" && pks.length === 1 && pks[0].kind === "int") pks[0].auto = true; // INTEGER PRIMARY KEY = auto rowid
  return { table, cols };
}
/** Order tables so every table comes after the tables it references (deps outside the list are ignored). Throws on a cycle. */
export function createOrder(tables: { name: string; deps: string[] }[]): string[] {
  const left = new Map(tables.map((t) => [t.name, new Set(t.deps.filter((d) => d !== t.name && tables.some((x) => x.name === d)))]));
  const out: string[] = [];
  while (left.size) {
    const ready = [...left].filter(([, deps]) => !deps.size).map(([n]) => n);
    if (!ready.length) throw new Error(`Tables refer to each other in a loop: ${[...left.keys()].join(", ")}`);
    for (const n of ready) (out.push(n), left.delete(n));
    for (const deps of left.values()) for (const n of ready) deps.delete(n);
  }
  return out;
}
export function createSql(d: Dialect, t: string, cols: NewCol[]) {
  const pks = cols.filter((c) => c.pk);
  const line = (c: NewCol) =>
    `${qid(d, c.name)} ${d === "sqlite" && c.auto ? "INTEGER" : c.type}` // SQLite: INTEGER PRIMARY KEY is the auto rowid
    + (c.auto && d === "postgres" ? " GENERATED BY DEFAULT AS IDENTITY" : "")
    + (c.nn ? " NOT NULL" : "")
    + (c.uniq ? " UNIQUE" : "")
    + (c.def.trim() ? ` DEFAULT ${c.def.trim()}` : "")
    + (c.pk && pks.length === 1 ? " PRIMARY KEY" : "")
    + (c.auto && d === "mysql" ? " AUTO_INCREMENT" : "");
  const lines = cols.map(line);
  if (pks.length > 1) lines.push(`PRIMARY KEY (${pks.map((c) => qid(d, c.name)).join(", ")})`);
  // table-level, because MySQL silently ignores a column-level REFERENCES
  for (const c of cols) if (c.ref) lines.push(`FOREIGN KEY (${qid(d, c.name)}) REFERENCES ${qid(d, c.ref.t)} (${qid(d, c.ref.c)})`);
  return `CREATE TABLE ${qid(d, t)} (\n  ${lines.join(",\n  ")}\n)`;
}

const where = (d: Dialect, keys: Col[], from: number) => keys.map((k, i) => `${qid(d, k.name)} = ${ph(d, from + i, k.type)}`).join(" AND ");
export const updateSql = (d: Dialect, t: string, col: Col, keys: Col[]) =>
  `UPDATE ${qid(d, t)} SET ${qid(d, col.name)} = ${ph(d, 1, col.type)} WHERE ${where(d, keys, 2)}`;
export const deleteSql = (d: Dialect, t: string, keys: Col[]) => `DELETE FROM ${qid(d, t)} WHERE ${where(d, keys, 1)}`;
export const insertSql = (d: Dialect, t: string) => `INSERT INTO ${qid(d, t)} ${d === "mysql" ? "() VALUES ()" : "DEFAULT VALUES"}`;

/** Every table's columns in the current database/schema, for editor autocomplete: rows of { t, c }. */
export const schemaSql = (d: Dialect) =>
  d === "sqlite" ? "SELECT m.name AS t, p.name AS c, p.type AS ty FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type IN ('table','view') ORDER BY m.name, p.cid"
  : d === "postgres" ? "SELECT table_name AS t, column_name AS c, data_type AS ty FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position"
  : "SELECT table_name AS t, column_name AS c, column_type AS ty FROM information_schema.columns WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position";

/** Objects view (like Navicat's): one row per table; the first column is always `name`. */
export const objectsSql = (d: Dialect) =>
  d === "sqlite" ? "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
  : d === "postgres"
    ? `SELECT c.relname AS name, CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS type,
        GREATEST(c.reltuples, 0)::bigint AS rows, pg_size_pretty(pg_total_relation_size(c.oid)) AS size, obj_description(c.oid) AS comment
       FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r','p','v','m') ORDER BY 1`
    : `SELECT table_name AS name, LOWER(REPLACE(table_type, 'BASE ', '')) AS type, auto_increment, update_time AS modified,
        data_length, engine, table_rows AS \`rows\`, table_comment AS comment
       FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1`;

/** Rows as CSV (RFC 4180 quoting). */
export function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]).filter((c) => c !== "__rowid");
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n");
}

const CRC = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
export const crc32 =(b: Uint8Array) => { let c = ~0; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };

/** Zip with stored (uncompressed) entries.
 * ponytail: no deflate, so files are ~5x bigger than Excel's own; use CompressionStream("deflate-raw") if size matters. */
export function zip(files: [name: string, text: string][]) {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], dir: Uint8Array[] = [];
  let off = 0;
  for (const [name, text] of files) {
    const n = enc.encode(name), d = enc.encode(text), crc = crc32(d);
    const hdr = (central: boolean) => {
      const h = new DataView(new ArrayBuffer(central ? 46 : 30));
      h.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
      const o = central ? 2 : 0; // central header has an extra "version made by" field
      h.setUint16(4 + o, 20, true); h.setUint16(6 + o, 0x0800, true); // UTF-8 names
      h.setUint32(14 + o, crc, true); h.setUint32(18 + o, d.length, true); h.setUint32(22 + o, d.length, true);
      h.setUint16(26 + o, n.length, true);
      if (central) h.setUint32(42, off, true);
      return new Uint8Array(h.buffer);
    };
    dir.push(hdr(true), n);
    parts.push(hdr(false), n, d);
    off += 30 + n.length + d.length;
  }
  const size = dir.reduce((s, p) => s + p.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, off, true);
  const out = new Uint8Array(off + size + 22);
  let p = 0;
  for (const b of [...parts, ...dir, new Uint8Array(end.buffer)]) (out.set(b, p), (p += b.length));
  return out;
}

/** Real .xlsx (one sheet, inline strings, numbers as numbers). */
export function toXlsx(rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]).filter((c) => c !== "__rowid") : [];
  const x = (s: string) => s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const ref = (i: number, r: number) => { let s = ""; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s + r; };
  const cell = (v: unknown, i: number, r: number) => v === null || v === undefined ? ""
    : typeof v === "number" && isFinite(v) ? `<c r="${ref(i, r)}"><v>${v}</v></c>`
    : `<c r="${ref(i, r)}" t="inlineStr"><is><t xml:space="preserve">${x(typeof v === "object" ? JSON.stringify(v) : String(v))}</t></is></c>`;
  const row = (vals: unknown[], r: number) => `<row r="${r}">${vals.map((v, i) => cell(v, i, r)).join("")}</row>`;
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n', R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return zip([
    ["[Content_Types].xml", `${X}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `${X}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${X}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `${X}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(cols, 1)}${rows.map((r, i) => row(cols.map((c) => r[c]), i + 2)).join("")}</sheetData></worksheet>`],
  ]);
}

/** Statement spans [from, to) split on `;` outside quotes and comments; blank ones dropped. */
export function statements(sql: string): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = 0, i = 0;
  const push = (end: number) => {
    const s = sql.slice(start, end);
    const lead = s.length - s.trimStart().length;
    if (s.trim()) out.push({ from: start + lead, to: start + s.trimEnd().length });
  };
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < sql.length && !(sql[i] === c && sql[i + 1] !== c)) i += sql[i] === c ? 2 : sql[i] === "\\" && c === "'" ? 2 : 1;
      i++;
    } else if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
    } else if (c === "$" && /^\$\w*\$/.test(sql.slice(i))) { // Postgres $tag$ ... $tag$ bodies
      const tag = /^\$\w*\$/.exec(sql.slice(i))![0], e = sql.indexOf(tag, i + tag.length);
      i = e < 0 ? sql.length : e + tag.length;
    } else if (c === ";") {
      push(i);
      start = ++i;
    } else i++;
  }
  push(sql.length);
  return out;
}
/** The statement the cursor is in (or right after its `;`). */
export const statementAt = (sql: string, pos: number) => {
  const all = statements(sql);
  return all.find((s) => pos >= s.from && pos <= s.to + 1) ?? all.filter((s) => s.to <= pos).pop() ?? all[0] ?? null;
};

/** A query that returns rows (vs. one that changes data). */
export const isRead = (sql: string) =>
  /^(select|pragma|with|explain|values|show|desc|describe)\b/i.test(sql.replace(/^(\s|--[^\n]*|\/\*[\s\S]*?\*\/)*/, "")); // after leading comments

/** Cap a SELECT/WITH that has no LIMIT/FETCH of its own, so a huge table can't overflow the IPC string (RangeError).
 * Asks for n+1 rows so the caller can tell there were more. LIMIT goes on a new line in case the query ends in a -- comment.
 * ponytail: a LIMIT anywhere (even in a subquery) counts as "has one"; `SELECT … FOR UPDATE` isn't capped. */
export function capRows(sql: string, n: number) {
  const body = sql.replace(/^(\s|--[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
  const capped = /^(select|with)\b/i.test(body) && !/\b(limit|fetch\s+first|fetch\s+next|for\s+update|for\s+share)\b/i.test(sql);
  return { sql: capped ? `${sql}\nLIMIT ${n + 1}` : sql, capped };
}

/** 850 ms / 16.2 s */
export const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** Connection form fields <-> saved URL (no password; that lives in the OS credential store). */
export type Kind = "postgres" | "mysql" | "mariadb" | "sqlite";
export const KIND_LABEL: Record<Kind, string> = { postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB", sqlite: "SQLite" };
/** `ssh` = id of a saved SSH server to tunnel through ("" = direct). */
export type ConnForm = { kind: Kind; host: string; port: string; database: string; user: string; file: string; ssh: string };
export const DEFAULTS: Record<Kind, Partial<ConnForm>> = {
  postgres: { host: "localhost", port: "5432", database: "postgres", user: "postgres" },
  mysql: { host: "localhost", port: "3306", database: "", user: "root" },
  mariadb: { host: "localhost", port: "3306", database: "", user: "root" },
  sqlite: { file: "" },
};
const enc = encodeURIComponent;
const isUrl = (s: string) => /^\w+:\/\//.test(s);
export const toUrl = (f: ConnForm) =>
  f.kind === "sqlite" ? f.file.trim()
  : `${f.kind}://${enc(f.user.trim())}@${f.host.trim()}:${f.port.trim()}/${enc(f.database.trim())}${f.ssh ? `?ssh=${f.ssh}` : ""}`;
export function fromUrl(s: string): ConnForm {
  const blank = { host: "", port: "", database: "", user: "", file: "", ssh: "" };
  if (!isUrl(s)) return { ...blank, kind: "sqlite", file: s.replace(/^sqlite:/, "") };
  const u = new URL(s), kind = u.protocol.replace(/ql:$|:$/, "") as Kind; // postgresql: -> postgres
  return { ...blank, kind, host: u.hostname, port: u.port, user: decodeURIComponent(u.username), database: decodeURIComponent(u.pathname.slice(1)), ssh: u.searchParams.get("ssh") ?? "" };
}
/** The DB server the SSH host should forward to, or null for a direct connection. */
export function tunnelOf(s: string): { ssh: number; host: string; port: number } | null {
  if (!isUrl(s)) return null;
  const u = new URL(s), ssh = +(u.searchParams.get("ssh") ?? "");
  return ssh ? { ssh, host: u.hostname || "localhost", port: +u.port || (/^postgres/.test(u.protocol) ? 5432 : 3306) } : null;
}
/** Dial through the local end of a tunnel (and drop ?ssh, which the driver would reject). */
export function viaLocal(s: string, port: number | null) {
  if (!isUrl(s)) return s;
  const u = new URL(s);
  u.searchParams.delete("ssh");
  if (port) (u.hostname = "127.0.0.1"), (u.port = String(port));
  return u.toString();
}
export function withPw(s: string, pw: string) {
  if (!pw || !isUrl(s)) return s;
  const u = new URL(s);
  u.password = pw;
  return u.toString();
}
/** Same server, another database (back to its default schema). */
export function withDb(s: string, dbName: string) {
  const u = new URL(s);
  u.pathname = "/" + enc(dbName);
  u.searchParams.delete("options");
  return u.toString();
}
/** Postgres: same database, another schema, via the startup `search_path` (sqlx reads `?options=`).
 * ponytail: names needing quotes (spaces, capitals) won't resolve; quote them if that comes up. */
export function withSchema(s: string, schema: string) {
  const u = new URL(s);
  u.searchParams.set("options", `-c search_path=${schema}`);
  return u.toString();
}
export const schemasSql = "SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY 1";
export const dbsSql = (d: Dialect) =>
  d === "postgres" ? "SELECT datname AS name FROM pg_database WHERE NOT datistemplate ORDER BY 1" : "SELECT schema_name AS name FROM information_schema.schemata ORDER BY 1";

// ----- editable query results -----
type Item = { q: string | null; col: string; as: string | null } | { expr: true; as: string | null };
export type Sel = { tables: { name: string; alias: string | null }[]; items: Item[] };
/** Where an editable result column lives: table, column, and which result columns hold that table's key values. */
export type Src = { t: string; col: Col; keys: [Col, string][] };

/** Split on commas (and `sep`) at paren depth 0, outside quotes. */
function splitTop(s: string, sep?: RegExp) {
  const out: string[] = [];
  let depth = 0, quote = "", from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) { if (ch === quote) quote = ""; continue; }
    if (`'"\``.includes(ch)) quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      const m = ch === "," ? [","] : sep ? s.slice(i).match(sep) : null;
      if (m) (out.push(s.slice(from, i)), (i += m[0].length - 1), (from = i + 1));
    }
  }
  return [...out, s.slice(from)].map((x) => x.trim());
}
const ID = String.raw`(?:"(?:[^"]|"")+"|\`(?:[^\`]|\`\`)+\`|\w+)`;
const unq = (d: Dialect, t: string) => (/^["`]/.test(t) ? t.slice(1, -1).split(t[0] + t[0]).join(t[0]) : d === "postgres" ? t.toLowerCase() : t);

/** Parse `SELECT list FROM t [a] [JOIN u [b] ON …]… [WHERE/ORDER/LIMIT …]`; null for anything fancier
 * (subqueries, unions, grouping, DISTINCT, schema-qualified names) — those results stay read-only. */
export function selectFrom(d: Dialect, sql: string): Sel | null {
  const s = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").trim().replace(/;\s*$/, "");
  if ((s.match(/\bselect\b/gi) ?? []).length !== 1 || /\b(union|intersect|except|group\s+by|distinct|having|window)\b/i.test(s)) return null;
  const m = s.match(/^select\s+([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:where|order\s+by|limit|offset|fetch|for)\b[\s\S]*)?$/i);
  if (!m) return null;
  const tables: Sel["tables"] = [];
  for (const p of splitTop(m[2], /^\s+(?:natural\s+)?(?:(?:inner|cross|(?:left|right|full)(?:\s+outer)?)\s+)?join\s+/i)) {
    const t = p.match(new RegExp(String.raw`^(${ID})(?:\s+(?:as\s+)?(?!on\b|using\b)(${ID}))?(?:\s+(?:on|using)\b[\s\S]*)?$`, "i"));
    if (!t) return null;
    tables.push({ name: unq(d, t[1]), alias: t[2] ? unq(d, t[2]) : null });
  }
  const items = splitTop(m[1]).map((it): Item => {
    const star = it.match(new RegExp(String.raw`^(?:(${ID})\.)?\*$`));
    if (star) return { q: star[1] ? unq(d, star[1]) : null, col: "*", as: null };
    const c = it.match(new RegExp(String.raw`^(?:(${ID})\.)?(${ID})(?:\s+(?:as\s+)?(${ID}))?$`, "i"));
    if (c) return { q: c[1] ? unq(d, c[1]) : null, col: unq(d, c[2]), as: c[3] ? unq(d, c[3]) : null };
    const a = it.match(new RegExp(String.raw`\s(?:as\s+)?(${ID})$`, "i"));
    return { expr: true, as: a ? unq(d, a[1]) : null };
  });
  return { tables, items };
}

/** Result column → its source, given each table's columns. A result name produced twice, or a table whose
 * primary key isn't in the result, stays read-only (we can't tell which row to update).
 * ponytail: unaliased expressions get driver-chosen names (e.g. "count"); a clash with a real column isn't detected. */
export function editCols(d: Dialect, p: Sel, structs: Map<string, Col[]>): Map<string, Src> {
  const same = (a: string, b: string) => (d === "postgres" ? a === b : a.toLowerCase() === b.toLowerCase());
  const colsOf = (i: number) => structs.get(p.tables[i].name) ?? [];
  const byQual = (q: string) => p.tables.findIndex((t) => (t.alias ? same(t.alias, q) : same(t.name, q)));
  const found = new Map<string, { ti: number; col: Col } | null>(), seen = new Map<string, number>();
  const add = (name: string, src: { ti: number; col: Col } | null) => (seen.set(name, (seen.get(name) ?? 0) + 1), found.set(name, src));
  for (const it of p.items) {
    if ("expr" in it) { if (it.as) add(it.as, null); continue; }
    if (it.col === "*") {
      const tis = it.q === null ? p.tables.map((_, i) => i) : [byQual(it.q)];
      for (const ti of tis) for (const col of ti < 0 ? [] : colsOf(ti)) add(col.name, { ti, col });
      continue;
    }
    const tis = it.q !== null ? [byQual(it.q)] : p.tables.map((_, i) => i).filter((i) => colsOf(i).some((c) => same(c.name, it.col)));
    const col = tis.length === 1 && tis[0] >= 0 ? colsOf(tis[0]).find((c) => same(c.name, it.col)) : undefined;
    add(it.as ?? it.col, col ? { ti: tis[0], col } : null);
  }
  const out = new Map<string, Src>();
  const keysOf = new Map<number, [Col, string][] | null>();
  for (const [name, src] of found) {
    if (!src || seen.get(name)! > 1) continue;
    if (!keysOf.has(src.ti)) {
      const pk = colsOf(src.ti).filter((c) => Number(c.pk));
      const ks = pk.map((k): [Col, string] | null => {
        const n = [...found].find(([n, s]) => s && s.ti === src.ti && s.col.name === k.name && seen.get(n) === 1)?.[0];
        return n === undefined ? null : [k, n];
      });
      keysOf.set(src.ti, pk.length && ks.every(Boolean) ? (ks as [Col, string][]) : null);
    }
    const keys = keysOf.get(src.ti);
    if (keys) out.set(name, { t: p.tables[src.ti].name, col: src.col, keys });
  }
  return out;
}

// ----- visual query builder -----
export type JoinType = "INNER" | "LEFT" | "RIGHT" | "FULL";
/** tables: alias `a` of table `t` (alias = name when used once); joins: "a.ac = b.bc" with `a TYPE JOIN b` meaning. */
export const FILTER_OPS = ["=", "<>", ">", ">=", "<", "<=", "contains", "LIKE", "IN", "IS NULL", "IS NOT NULL"] as const;
export type QbFilter = { a: string; c: string; op: (typeof FILTER_OPS)[number]; v: string };
/** filters: value boxes linked to a column, ANDed into WHERE after the free-text `where`. */
export type Qb = { tables: { a: string; t: string }[]; joins: { a: string; ac: string; b: string; bc: string; type: JoinType }[]; cols: { a: string; c: string }[]; where: string; limit: number; filters?: QbFilter[] };

/** SQL for the builder. The first table is FROM; others attach through their joins (LEFT/RIGHT flip when written from
 * the other side); a second join between tables already in becomes an extra AND on the later one; unconnected tables CROSS JOIN. */
export function builderSql(d: Dialect, q: Qb): string {
  if (!q.tables.length) return "";
  const id = (s: string) => qid(d, s), ref = (x: { a: string; t: string }) => (x.a === x.t ? id(x.t) : `${id(x.t)} AS ${id(x.a)}`);
  const cond = (j: Qb["joins"][number]) => `${id(j.a)}.${id(j.ac)} = ${id(j.b)}.${id(j.bc)}`;
  const flip: Record<JoinType, JoinType> = { INNER: "INNER", LEFT: "RIGHT", RIGHT: "LEFT", FULL: "FULL" };
  const order = [q.tables[0].a], on = new Map<string, { type: string; conds: string[] }>();
  let rest = q.joins.filter((j) => j.a !== j.b);
  for (;;) {
    let moved = true;
    while (moved) {
      moved = false;
      for (const j of rest) {
        const ia = order.indexOf(j.a), ib = order.indexOf(j.b);
        if (ia >= 0 && ib >= 0) on.get(order[Math.max(ia, ib)])?.conds.push(cond(j));
        else if (ia >= 0) (order.push(j.b), on.set(j.b, { type: j.type, conds: [cond(j)] }));
        else if (ib >= 0) (order.push(j.a), on.set(j.a, { type: flip[j.type], conds: [cond(j)] }));
        else continue;
        rest = rest.filter((x) => x !== j);
        moved = true;
        break;
      }
    }
    const loose = q.tables.find((t) => !order.includes(t.a));
    if (!loose) break;
    order.push(loose.a);
    on.set(loose.a, { type: "CROSS", conds: [] });
  }
  const byA = new Map(q.tables.map((t) => [t.a, t]));
  const dup = new Set(q.cols.map((c) => c.c).filter((c, i, all) => all.indexOf(c) !== i));
  const cols = q.cols.length ? q.cols.map((c) => `${id(c.a)}.${id(c.c)}${dup.has(c.c) ? ` AS ${id(`${c.a}_${c.c}`)}` : ""}`).join(",\n  ") : "*";
  const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const fcond = (f: QbFilter) => {
    const col = `${id(f.a)}.${id(f.c)}`;
    if (f.op === "IS NULL" || f.op === "IS NOT NULL") return `${col} ${f.op}`;
    if (f.op === "contains") return `${col} LIKE ${lit(`%${f.v}%`)}`;
    if (f.op === "IN") return `${col} IN (${f.v.split(",").map((s) => lit(s.trim())).join(", ")})`;
    return `${col} ${f.op} ${lit(f.v)}`;
  };
  const fs = (q.filters ?? []).filter((f) => byA.has(f.a)).map(fcond), user = whereOf(q.where).replace(/^ WHERE /, "");
  const conds = [...(user ? [fs.length ? `(${user})` : user] : []), ...fs];
  const where = conds.length ? `WHERE ${conds.join("\n  AND ")}` : "";
  return [`SELECT ${cols}`, `FROM ${ref(q.tables[0])}`,
    ...order.slice(1).map((a) => { const j = on.get(a)!; return `${j.type} JOIN ${ref(byA.get(a)!)}${j.conds.length ? ` ON ${j.conds.join(" AND ")}` : ""}`; }),
    ...(where ? [where] : []), ...(q.limit > 0 ? [`LIMIT ${q.limit}`] : [])].join("\n");
}
