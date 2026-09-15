import { defineConfig } from "vitest/config";

// One run covers the package tests and both examples.
export default defineConfig({
  test: { include: ["test/**/*.test.ts", "examples/*/test/**/*.test.ts"] },
});
