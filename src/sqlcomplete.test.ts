// Run: node src/sqlcomplete.test.ts
import assert from "node:assert/strict";
import { contextAt, joinConds, refsIn } from "./sqlcomplete.ts";

assert.deepEqual(refsIn("select * from patient p, ovst AS o left join vn_stat v on v.vn = o.vn where p.hn = 'from x'"), [
  { table: "patient", alias: "p" }, { table: "ovst", alias: "o" }, { table: "vn_stat", alias: "v" },
]);
assert.deepEqual(refsIn('SELECT 1 FROM public."My Table" WHERE x'), [{ table: "My Table", alias: "" }]);
assert.deepEqual(refsIn("update users set a = 1"), [{ table: "users", alias: "" }]);
assert.deepEqual(refsIn("insert into logs (a) values (1)"), [{ table: "logs", alias: "" }]);

assert.equal(contextAt(""), "start");
assert.equal(contextAt("select * from "), "table");
assert.equal(contextAt("select * from a, "), "table");
assert.equal(contextAt("select a, "), "column");
assert.equal(contextAt("select * from a left join b on "), "on");
assert.equal(contextAt("select * from a where x = 1 and "), "column");
assert.equal(contextAt("select * from a "), "after");
assert.equal(contextAt("select * from a where note = 'from "), "none"); // inside a string
assert.equal(contextAt("select * from a where note = 'x' and "), "column");
assert.equal(contextAt("select 1 -- from "), "none");

const cols: Record<string, string[]> = { patient: ["hn", "pname"], ovst: ["vn", "hn", "patient_id"], vn_stat: ["vn", "hn"] };
const cf = (t: string) => cols[t] ?? [];
assert.deepEqual(joinConds([{ table: "patient", alias: "p" }, { table: "ovst", alias: "o" }], cf), ["o.hn = p.hn"]);
assert.deepEqual(joinConds([{ table: "ovst", alias: "o" }, { table: "vn_stat", alias: "" }], cf), ["vn_stat.vn = o.vn", "vn_stat.hn = o.hn"]);
assert.deepEqual(joinConds([{ table: "patient", alias: "" }], cf), []);
console.log("sqlcomplete ok");
