import { createRepoVitestAliases } from "./vitest.aliases";

export default {
  resolve: {
    alias: createRepoVitestAliases(__dirname),
  },
  test: {
    globals: true,
    environment: "node",
    include: [
      "apps/api/src/**/*.test.ts",
      "apps/web/src/**/*.test.ts?(x)",
      "integrations/**/__tests__/**/*.test.ts",
      "packages/core/src/**/*.test.ts",
      "packages/cli/__tests__/**/*.test.ts",
      "packages/hey-api-client-fetch/**/*.test.ts",
      "packages/shared-mobility/__tests__/**/*.test.ts",
    ],
  },
};
