import { resolve } from "node:path";

export function createRepoVitestAliases(repoRoot: string) {
  return [
    {
      find: /^@openmapx\/core\/server$/,
      replacement: resolve(repoRoot, "packages/core/src/server.ts"),
    },
    {
      find: /^@openmapx\/core$/,
      replacement: resolve(repoRoot, "packages/core/src/index.ts"),
    },
    {
      find: /^@openmapx\/integration-shared-mobility\/(.+)$/,
      replacement: resolve(repoRoot, "packages/shared-mobility/$1"),
    },
    {
      find: /^@openmapx\/integration-shared-mobility$/,
      replacement: resolve(repoRoot, "packages/shared-mobility"),
    },
    {
      find: /^@openmapx\/mobility-formats$/,
      replacement: resolve(repoRoot, "packages/mobility-formats/index.ts"),
    },
    {
      find: /^@openmapx\/integration-framework$/,
      replacement: resolve(repoRoot, "packages/integration-framework/src/index.ts"),
    },
    {
      find: /^@integrations\/(.+)$/,
      replacement: resolve(repoRoot, "integrations/$1"),
    },
  ];
}
