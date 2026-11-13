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

/** Column names/types/PK flag; one param: the table (Postgres: quoted name, for regclass). SQLite needs none. */
export const colsSql = (d: Dialect) =>
  d === "postgres"
    ? `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
        EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY(i.indkey)) AS pk
       FROM pg_attribute a WHERE a.attrelid = CAST($1 AS regclass) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`
    : d === "mysql"
      ? "SELECT column_name AS name, column_type AS type, column_key = 'PRI' AS pk FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position"
      : "";

// ponytail: WITHOUT ROWID SQLite tables can't be edited here; use the SQL box.
export const selectSql = (d: Dialect, t: string, limit = 500) =>
  `SELECT ${d === "sqlite" ? "rowid AS __rowid, " : ""}* FROM ${qid(d, t)} LIMIT ${limit}`;

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
  u.search = "";
  if (port) (u.hostname = "127.0.0.1"), (u.port = String(port));
  return u.toString();
}
export function withPw(s: string, pw: string) {
  if (!pw || !isUrl(s)) return s;
  const u = new URL(s);
  u.password = pw;
  return u.toString();
}
/** Same server, another database. */
export function withDb(s: string, dbName: string) {
  const u = new URL(s);
  u.pathname = "/" + enc(dbName);
  return u.toString();
}
export const dbsSql = (d: Dialect) =>
  d === "postgres" ? "SELECT datname AS name FROM pg_database WHERE NOT datistemplate ORDER BY 1" : "SELECT schema_name AS name FROM information_schema.schemata ORDER BY 1";
