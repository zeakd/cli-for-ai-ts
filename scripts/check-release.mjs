import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
assert.equal(process.env.RELEASE_REF, "refs/heads/main", "Run releases from main");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
assert.equal(pkg.name, "cli-for-ai");
assert.equal(pkg.repository.url, "git+https://github.com/zeakd/cli-for-ai-ts.git");
assert.equal(pkg.version, process.env.EXPECTED_VERSION, "Expected version must match package.json");
assert.ok(["next", "latest"].includes(process.env.RELEASE_TAG), "Invalid distribution tag");
assert.ok(process.env.RELEASE_TAG !== "latest" || !pkg.version.includes("-"), "Prereleases must use next");
if (process.env.PUBLISH === "true") {
  assert.equal(process.env.PRIVATE_REPOSITORY, "false", "Make the repository public before product publication with provenance");
}
console.log(`Verified ${pkg.name}@${pkg.version} for ${process.env.RELEASE_TAG}`);
