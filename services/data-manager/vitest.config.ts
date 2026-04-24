import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { createRepoVitestAliases } from "../../vitest.aliases";

export default defineConfig({
  resolve: {
    alias: createRepoVitestAliases(resolve(__dirname, "../..")),
  },
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
});
