import { defineConfig } from "vitest/config";
import { createRepoVitestAliases } from "./vitest.aliases";

// Single source of truth for the whole repo's test run. Two projects split the
// suite by environment: `node` for backend/lib code, `web` (jsdom) for the
// Next.js app and the React-bound packages. Scope a run with
// `pnpm test --project web` / `--project node`, or filter by path/name
// (`pnpm vitest run <substring>`). There are intentionally no per-package
// vitest configs — this file owns discovery for every workspace.
const alias = createRepoVitestAliases(__dirname);

// Shared by both projects: workspace import aliases + global test APIs, plus the
// @mui/material inline. MUI 9.1.0 vendored its own Transition whose .mjs build
// imports `react-transition-group/TransitionGroupContext` as a bare,
// extensionless subpath; react-transition-group 4.4.5 ships no `exports` map, so
// Node's native ESM loader rejects it while vite's resolver handles it. Inlining
// MUI routes the import through vite, matching production resolution.
const shared = {
  resolve: { alias },
  test: {
    globals: true,
    // 5s (the default) is too tight under full-suite CPU saturation for the
    // legitimately slow tests — real crypto KDFs (mangrove-react keypair
    // decrypt) and the conformance test's 84 per-integration dynamic imports.
    // 15s keeps headroom while still catching a genuine hang.
    testTimeout: 15_000,
    server: { deps: { inline: [/@mui\/material/] } },
  },
};

export default defineConfig({
  test: {
    // Collected non-gating in CI for now (no thresholds) to establish an honest
    // repo-wide baseline; gate later. `include` spans real source only.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "apps/*/src/**",
        "packages/*/src/**",
        "packages/*/*.ts",
        "integrations/**",
        "services/data-manager/**",
      ],
      exclude: [
        "**/node_modules/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        "**/__tests__/**",
        "**/test/**",
        "**/*.config.*",
        "**/types.ts",
        "**/types/**",
      ],
    },
    projects: [
      {
        ...shared,
        test: {
          ...shared.test,
          name: "node",
          environment: "node",
          setupFiles: ["./vitest.setup.node.ts"],
          include: [
            "apps/api/src/**/*.test.ts",
            "apps/api/scripts/**/*.test.ts",
            // Mobile Node-side config/plugin tests only. React Native component
            // and coordinator tests run under `apps/mobile`'s own jest-expo
            // project, which neither Vitest environment can host.
            "apps/mobile/config/**/*.test.ts",
            "apps/mobile/plugins/**/*.test.ts",
            "apps/mobile/scripts/**/*.test.ts",
            "apps/mobile/qa/**/*.test.ts",
            "apps/mobile/release/**/*.test.ts",
            "apps/mobile/compliance/**/*.test.ts",
            "apps/mobile/store/**/*.test.ts",
            "integrations/**/*.test.ts",
            "packages/**/*.test.ts",
            "scripts/**/*.test.ts",
            "services/dawarich-app/**/*.test.ts",
            "services/dawarich-sidekiq/**/*.test.ts",
            "services/data-manager/**/*.test.ts",
            "services/motis-feed-proxy/**/*.test.ts",
          ],
          // jsdom-owned paths run in the `web` project below — exclude here so
          // they don't run twice.
          exclude: [
            "**/node_modules/**",
            "packages/core/src/hooks/**",
            "packages/mangrove-react/**",
          ],
        },
      },
      {
        ...shared,
        test: {
          ...shared.test,
          name: "web",
          environment: "jsdom",
          setupFiles: ["./apps/web/src/test/setup.ts"],
          include: [
            "apps/web/src/**/*.test.ts?(x)",
            "packages/core/src/hooks/**/*.test.ts?(x)",
            "packages/mangrove-react/**/*.test.ts?(x)",
            // Integration map-layer/legend components render React against jsdom
            // and import the web app's `@/*` aliases, so they belong here rather
            // than in the plain-node `integrations/**/*.test.ts` suite above.
            "integrations/**/*.test.tsx",
          ],
          exclude: ["**/node_modules/**"],
        },
      },
    ],
  },
});
