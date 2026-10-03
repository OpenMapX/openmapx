import { resolve } from "node:path";

// Re-exported from `@openmapx/core` so CLI consumers can keep importing from
// the local `lib/paths` path. The implementation lives in core because
// apps/api also depends on it — single source of truth for repo-root
// detection.
export { findRepoRoot, type RepoPaths, repoPaths } from "@openmapx/core/server";

/**
 * Resolve a path the operator typed. `pnpm openmapx` runs the CLI from
 * `packages/cli`, so relative paths are taken against the directory the
 * command was invoked from (`INIT_CWD`), not the process cwd.
 */
export function resolveInvocationPath(path: string): string {
  return resolve(process.env.INIT_CWD ?? process.cwd(), path);
}
