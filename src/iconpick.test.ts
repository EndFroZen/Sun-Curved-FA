// Run: node src/iconpick.test.ts
import assert from "node:assert/strict";
import { iconNames, lucide } from "./iconpick.ts";

assert.ok(iconNames.length > 1000, "whole Lucide set");
assert.ok(iconNames.includes("rocket") && iconNames.includes("a-arrow-down"));
assert.equal(new Set(iconNames).size, iconNames.length, "no duplicate names");
assert.match(lucide("rocket", "h-5 w-5"), /^<svg class="h-5 w-5 shrink-0".*<path d="[^"]+"\/>.*<\/svg>$/);
assert.equal(lucide("nope"), "");
console.log("iconpick ok", iconNames.length);
