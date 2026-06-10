import { createRepoVitestAliases } from "./vitest.aliases";

export default {
  resolve: {
    alias: createRepoVitestAliases(__dirname),
  },
  test: {
    globals: true,
    environment: "node",
    // @mui/material 9.1.0 vendored its own internal Transition (to add a custom
    // Transition component + prefers-reduced-motion support), whose .mjs build
    // imports `react-transition-group/TransitionGroupContext` as a bare,
    // extensionless subpath. react-transition-group 4.4.5 ships no `exports`
    // map, so Node's strict native-ESM loader rejects it — while vite and the
    // production bundler resolve it fine. Inlining MUI routes the import through
    // vite's resolver, matching production resolution.
    server: {
      deps: {
        inline: [/@mui\/material/],
      },
    },
    include: [
      "apps/api/src/**/*.test.ts",
      "apps/web/src/**/*.test.ts?(x)",
      "integrations/**/*.test.ts",
      "packages/*/**/*.test.ts",
      "services/data-manager/**/*.test.ts",
      "services/motis-feed-proxy/**/*.test.ts",
    ],
  },
};
