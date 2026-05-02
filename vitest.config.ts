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
      "integrations/**/*.test.ts",
      "packages/*/**/*.test.ts",
      "services/data-manager/**/*.test.ts",
    ],
  },
};
