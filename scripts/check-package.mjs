import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("release", { recursive: true });
const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", "release"], { encoding: "utf8" }));
assert.equal(packed.length, 1);
assert.equal(packed[0].name, pkg.name);
assert.equal(packed[0].version, pkg.version);
const entries = new Set(packed[0].files.map((file) => file.path));
for (const entry of Object.values(pkg.exports)) {
  for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
    assert.ok(entries.has(target.replace(/^\.\//, "")), `Missing export: ${target}`);
  }
}
const artifact = resolve("release/package.tgz");
renameSync(join("release", packed[0].filename), artifact);
writeFileSync("release/manifest.json", JSON.stringify(packed[0], null, 2) + "\n");
const consumer = mkdtempSync(join(tmpdir(), "cli-for-ai-release-"));
try {
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", artifact, "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer, stdio: "inherit" });
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { application, command, output, completed, execute } from "cli-for-ai";
    import { run } from "cli-for-ai/node";
    const app = application({ name: "probe", version: "1.0.0", summary: "Package probe", commands: {
      ping: command({ summary: "Return a value", output: output(), run: () => completed("pong") })
    } });
    const result = await execute(app, ["ping"], { context: () => ({}) });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { status: "completed", data: "pong" });
    assert.equal(typeof run, "function");
  `], { cwd: consumer, stdio: "inherit" });
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
console.log(`Verified ${pkg.name}@${pkg.version}: ${packed[0].integrity}`);

if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `integrity=${packed[0].integrity}\n`);
