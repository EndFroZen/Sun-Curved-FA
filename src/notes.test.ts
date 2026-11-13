// Run: node src/notes.test.ts
import assert from "node:assert/strict";
import { toggleTask } from "./notes.ts";

const md = "## Deploy\n- [ ] backup\n  * [x] nested\n1. [ ] build\ntext [ ] not a task";
assert.equal(toggleTask(md, 0), md.replace("- [ ] backup", "- [x] backup"));
assert.equal(toggleTask(md, 1), md.replace("* [x] nested", "* [ ] nested"));
assert.equal(toggleTask(md, 2), md.replace("1. [ ] build", "1. [x] build"));
assert.equal(toggleTask(md, 3), md); // out of range: unchanged
console.log("notes ok");

import { safeMd } from "./notes.ts";
assert.ok(!safeMd("<img src=x onerror=alert(1)>").includes("<img"));
assert.ok(!safeMd("[x](javascript:alert(1))").includes("href"));
assert.ok(safeMd("| a | b |\n|---|---|\n| 1 | 2 |").includes("<table>"));
console.log("safeMd ok");
