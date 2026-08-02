import { resolve } from "node:path";

/**
 * Subpaths whose source files live under `packages/mobility-core/src/types/`.
 * Everything else (cache, policy, dedup, gbfs-*, mapper, motis-rentals,
 * nominatim, entur-mobility) lives at `packages/mobility-core/src/`.
 */
const MOBILITY_CORE_TYPE_SUBPATHS = [
  "attribution",
  "freshness",
  "result",
  "parking",
  "fuel",
  "ev-charging",
  "transit",
];

export function createRepoVitestAliases(repoRoot: string) {
  const mobilityCoreTypeAliases = MOBILITY_CORE_TYPE_SUBPATHS.map((sub) => ({
    find: new RegExp(`^@openmapx/mobility-core/${sub}(?:\\.js)?$`),
    replacement: resolve(repoRoot, `packages/mobility-core/src/types/${sub}.ts`),
  }));

  return [
    {
      find: /^@openmapx\/core\/server$/,
      replacement: resolve(repoRoot, "packages/core/src/server.ts"),
    },
    {
      find: /^@openmapx\/core\/feed-id$/,
      replacement: resolve(repoRoot, "packages/core/src/feed-id.ts"),
    },
    {
      find: /^@openmapx\/core\/services\/secret-key$/,
      replacement: resolve(repoRoot, "packages/core/src/services/secret-key.ts"),
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
      find: /^@openmapx\/extension-sdk\/testing$/,
      replacement: resolve(repoRoot, "packages/extension-sdk/src/testing.ts"),
    },
    {
      find: /^@openmapx\/extension-sdk$/,
      replacement: resolve(repoRoot, "packages/extension-sdk/src/index.ts"),
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
