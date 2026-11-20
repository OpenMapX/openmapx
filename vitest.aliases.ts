import { resolve } from "node:path";

/**
 * Aliases that are not package resolution. Workspace packages resolve through
 * each workspace's declared dependencies and the packages' `exports`, as they
 * do for TypeScript and the bundlers.
 */
export function createRepoVitestAliases(repoRoot: string) {
  return [
    // All integration React tests use the web host's declared runtime, even
    // when an integration package exposes its frontend only through the host.
    { find: "react", replacement: resolve(repoRoot, "apps/web/node_modules/react") },
    { find: "react-dom", replacement: resolve(repoRoot, "apps/web/node_modules/react-dom") },
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
