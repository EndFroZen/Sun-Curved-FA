// Run: node src/post.test.ts
import assert from "node:assert/strict";
import { parseHeaders, pretty, withScheme } from "./post.ts";

assert.deepEqual(parseHeaders("Content-Type: application/json\n\n# x: y\nAuthorization: Bearer a:b\nbad\n: v"), [
  ["Content-Type", "application/json"],
  ["Authorization", "Bearer a:b"],
]);
assert.equal(pretty('{"a":1}'), '{\n  "a": 1\n}');
assert.equal(pretty("<html>"), "<html>");
assert.equal(withScheme(" example.com/x "), "https://example.com/x");
assert.equal(withScheme("http://a"), "http://a");
console.log("post ok");
