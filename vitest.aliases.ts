import { resolve } from "node:path";

/**
 * Subpaths whose source files live under `packages/mobility-core/src/types/`.
 * Most other public modules live directly under `packages/mobility-core/src/`.
 * Server-only modules with deeper paths have explicit aliases below.
 */
const MOBILITY_CORE_TYPE_SUBPATHS = [
  "attribution",
  "freshness",
  "result",
  "parking",
  "fuel",
  "ev-charging",
  "transit",
  "transit-reachability",
];

export function createRepoVitestAliases(repoRoot: string) {
  const mobilityCoreTypeAliases = MOBILITY_CORE_TYPE_SUBPATHS.map((sub) => ({
    find: new RegExp(`^@openmapx/mobility-core/${sub}(?:\\.js)?$`),
    replacement: resolve(repoRoot, `packages/mobility-core/src/types/${sub}.ts`),
  }));

  return [
    {
      find: /^@openmapx\/brands$/,
      replacement: resolve(repoRoot, "packages/brands/src/index.ts"),
    },
    {
      find: /^@openmapx\/core\/server$/,
      replacement: resolve(repoRoot, "packages/core/src/server.ts"),
    },
    {
      find: /^@openmapx\/core\/ops$/,
      replacement: resolve(repoRoot, "packages/core/src/ops/index.ts"),
    },
    {
      find: /^@openmapx\/core\/transitous-runner$/,
      replacement: resolve(repoRoot, "packages/core/src/transitous-runner/index.ts"),
    },
    {
      find: /^@openmapx\/core\/feed-id$/,
      replacement: resolve(repoRoot, "packages/core/src/feed-id.ts"),
    },
    {
      find: /^@openmapx\/core\/services\/secret-key$/,
      replacement: resolve(repoRoot, "packages/core/src/services/secret-key.ts"),
    },
    // Must precede the root alias: the curated headless navigation subpath is a
    // different, deliberately smaller module than the root barrel.
    {
      find: /^@openmapx\/core\/navigation$/,
      replacement: resolve(repoRoot, "packages/core/src/navigation/index.ts"),
    },
    {
      find: /^@openmapx\/core$/,
      replacement: resolve(repoRoot, "packages/core/src/index.ts"),
    },
    // The `./types` subpath is the SharedMobility* type bundle (renamed from
    // the old root `types.ts` to `src/types/shared-mobility.ts`).
    {
      find: /^@openmapx\/mobility-core\/types$/,
      replacement: resolve(repoRoot, "packages/mobility-core/src/types/shared-mobility.ts"),
    },
    ...mobilityCoreTypeAliases,
    {
      find: /^@openmapx\/mobility-core\/ris-client(?:\.js)?$/,
      replacement: resolve(repoRoot, "packages/mobility-core/src/server/ris-client.ts"),
    },
    {
      find: /^@openmapx\/mobility-core\/motis-client(?:\.js)?$/,
      replacement: resolve(repoRoot, "packages/mobility-core/src/server/motis-client.ts"),
    },
    // Everything else under the package resolves to `src/<sub>.ts`.
    {
      find: /^@openmapx\/mobility-core\/(.+?)(?:\.js)?$/,
      replacement: resolve(repoRoot, "packages/mobility-core/src/$1.ts"),
    },
    {
      find: /^@openmapx\/mobility-core$/,
      replacement: resolve(repoRoot, "packages/mobility-core/src"),
    },
    {
      find: /^@openmapx\/mobility-formats$/,
      replacement: resolve(repoRoot, "packages/mobility-formats/index.ts"),
    },
    {
      find: /^@openmapx\/integration-framework\/testing$/,
      replacement: resolve(repoRoot, "packages/integration-framework/src/testing/index.ts"),
    },
    {
      find: /^@openmapx\/integration-framework\/installer$/,
      replacement: resolve(repoRoot, "packages/integration-framework/src/installer.ts"),
    },
    {
      find: /^@openmapx\/integration-framework\/react$/,
      replacement: resolve(repoRoot, "packages/integration-framework/src/react.ts"),
    },
    {
      find: /^@openmapx\/integration-framework$/,
      replacement: resolve(repoRoot, "packages/integration-framework/src/index.ts"),
    },
    {
      find: /^@integrations\/(.+)$/,
      replacement: resolve(repoRoot, "integrations/$1"),
    },
    // `@/*` resolves to `apps/web/src/*` to match the Next.js path alias so
    // tests can import the web app's source modules.
    {
      find: /^@\/(.+)$/,
      replacement: resolve(repoRoot, "apps/web/src/$1"),
    },
  ];
}
