// Run: node src/basecurves.test.ts
import assert from "node:assert/strict";
import { connUrl, qid, updateSql, deleteSql, isRead, toXlsx, crc32 } from "./basecurves.ts";

assert.deepEqual(connUrl("suncurved.db"), { url: "sqlite:suncurved.db", d: "sqlite" });
assert.deepEqual(connUrl("postgresql://u:p@h/db"), { url: "postgres://u:p@h/db", d: "postgres" });
assert.deepEqual(connUrl("mariadb://u@h/db"), { url: "mysql://u@h/db", d: "mysql" });
assert.equal(qid("sqlite", 'a"b'), '"a""b"');
assert.equal(qid("mysql", "a`b"), "`a``b`");
const rowid = [{ name: "rowid", type: "", pk: true }];
assert.equal(updateSql("sqlite", "t x", { name: "c", type: "", pk: false }, rowid), 'UPDATE "t x" SET "c" = $1 WHERE "rowid" = $2');
const pk = [{ name: "a", type: "integer", pk: true }, { name: "b", type: "uuid", pk: true }];
assert.equal(updateSql("postgres", "t", { name: "c", type: "date", pk: false }, pk), 'UPDATE "t" SET "c" = CAST($1 AS date) WHERE "a" = CAST($2 AS integer) AND "b" = CAST($3 AS uuid)');
assert.equal(deleteSql("mysql", "t", pk), "DELETE FROM `t` WHERE `a` = ? AND `b` = ?");
assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
const xlsx = new TextDecoder().decode(toXlsx([{ id: 1, name: "a<b&\x01", n: null }]));
assert.ok(xlsx.startsWith("PK\x03\x04") && xlsx.includes('<c r="A2"><v>1</v></c>') && xlsx.includes(">a&lt;b&amp;</t>") && xlsx.includes('<c r="C1" t="inlineStr">'));
assert.ok(isRead("  select 1")&& isRead("SHOW TABLES") && !isRead("delete from x"));
console.log("basecurves ok");

import { toUrl, fromUrl, withPw, withDb } from "./basecurves.ts";
const f = { kind: "mariadb" as const, host: "h", port: "3306", database: "", user: "r@t", file: "", ssh: "" };
assert.equal(toUrl(f), "mariadb://r%40t@h:3306/");
assert.deepEqual(fromUrl(toUrl(f)), f);
assert.equal(fromUrl("postgresql://u@h:5432/db").kind, "postgres");
assert.deepEqual(fromUrl("C:/x.db"), { kind: "sqlite", host: "", port: "", database: "", user: "", file: "C:/x.db", ssh: "" });
assert.equal(connUrl("mariadb://r@h:3306/").url, "mysql://r@h:3306/information_schema");
assert.equal(connUrl("postgres://u@h:5432/app").url, "postgres://u@h:5432/app");
assert.equal(withPw("mysql://u@h/db", "p@ss"), "mysql://u:p%40ss@h/db");
assert.equal(withDb("postgres://u:p@h:5432/a", "b"), "postgres://u:p@h:5432/b");
console.log("conn ok");

import { tunnelOf, viaLocal } from "./basecurves.ts";
const tu = toUrl({ ...f, kind: "postgres", port: "", database: "app", ssh: "7" });
assert.equal(tu, "postgres://r%40t@h:/app?ssh=7");
assert.equal(fromUrl(tu).ssh, "7");
assert.deepEqual(tunnelOf(tu), { ssh: 7, host: "h", port: 5432 });
assert.equal(tunnelOf("mysql://u@h:3307/db"), null);
assert.equal(viaLocal("mysql://u:p@db.internal:3307/x?ssh=2", 50123), "mysql://u:p@127.0.0.1:50123/x");
assert.equal(viaLocal("mysql://u@h:3307/x", null), "mysql://u@h:3307/x");
console.log("tunnel ok");

import { statements, statementAt } from "./basecurves.ts";
const sq = "select 1;\n-- a;b\nselect ';' as x; /* ; */ update t set a='it''s;'\n;\n$f$ begin; end $f$;  ";
const txt = (s: { from: number; to: number } | null) => (s ? sq.slice(s.from, s.to) : null);
assert.deepEqual(statements(sq).map(txt), ["select 1", "-- a;b\nselect ';' as x", "/* ; */ update t set a='it''s;'", "$f$ begin; end $f$"]);
assert.equal(txt(statementAt(sq, 3)), "select 1");
assert.equal(txt(statementAt(sq, sq.indexOf("as x"))), "-- a;b\nselect ';' as x");
assert.equal(txt(statementAt(sq, sq.length)), "$f$ begin; end $f$");
assert.equal(statementAt("  ", 0), null);
assert.ok(isRead("-- x\n /* y */ SELECT 1") && !isRead("-- select\nupdate t"));
console.log("statements ok");

import { toCsv } from "./basecurves.ts";
assert.equal(toCsv([{ __rowid: 1, a: 'x,"y"', b: null }, { __rowid: 2, a: "z", b: 3 }]), 'a,b\r\n"x,""y""",\r\nz,3');
console.log("csv ok");
