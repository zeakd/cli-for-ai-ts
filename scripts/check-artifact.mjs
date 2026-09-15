import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const actual = "sha512-" + createHash("sha512").update(readFileSync("release/package.tgz")).digest("base64");
assert.equal(actual, process.env.EXPECTED_INTEGRITY, "Downloaded artifact must match the verified package");
console.log("Artifact integrity verified");
