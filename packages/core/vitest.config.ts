import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { createRepoVitestAliases } from "../../vitest.aliases";

// Local config so `pnpm -C packages/core test` discovers the co-located
// suites under src/__tests__. The root vitest.config.ts also matches these
// via `packages/core/src/**/*.test.ts`, but its `include` is interpreted
// relative to whatever cwd Vitest starts in — so running it from this
// package directly needs a package-local include pattern.
export default defineConfig({
  resolve: {
    alias: createRepoVitestAliases(resolve(__dirname, "../..")),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
