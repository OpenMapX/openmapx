// Single source of truth for finding the OpenMapX repo root and the canonical
// subdirectories underneath it. Used by:
//
//   - The `pnpm openmapx` CLI (anywhere inside the repo tree)
//   - apps/api at runtime (resolves the root via OPENMAPX_ROOT_DIR or the
//     installed location of this module via import.meta.url)
//   - The integration installer (when called from either of the above)
//
// Sentinel-based detection: a workspace marker (`pnpm-workspace.yaml` or
// `turbo.json`) AND at least one OpenMapX-specific top-level dir. The
// OpenMapX sentinel distinguishes the repo from an enclosing pnpm/turbo
// monorepo when this code runs inside a nested checkout (vendored copy,
// worktree-of-a-worktree, etc.).

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const OPENMAPX_DIRS = ["services", "packages", "apps", "integrations"];

function isRepoRoot(dir: string): boolean {
  const hasWorkspace =
    existsSync(join(dir, "pnpm-workspace.yaml")) || existsSync(join(dir, "turbo.json"));
  if (!hasWorkspace) return false;
  return OPENMAPX_DIRS.some((sub) => existsSync(join(dir, sub)));
}

/**
 * Walk up from `start` looking for the repo root. Throws if no marker is
 * found before hitting `/`. Pass `OPENMAPX_ROOT_DIR` (env) to short-circuit
 * detection — useful when the API is bundled and `import.meta.url` doesn't
 * point at a meaningful path.
 */
export function findRepoRoot(start?: string): string {
  const fromEnv = process.env.OPENMAPX_ROOT_DIR;
  if (fromEnv) return resolve(fromEnv);

  // This walk is intentionally a runtime lookup for CLI/API deployments and
  // the web's externally mounted custom-integrations directory. It is not a
  // request for Next/Turbopack to trace the entire build workspace.
  let dir = resolve(/* turbopackIgnore: true */ start ?? process.cwd());
  while (dir !== dirname(dir)) {
    if (isRepoRoot(dir)) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    `Could not find OpenMapX repo root above ${start ?? process.cwd()} ` +
      `(looked for pnpm-workspace.yaml/turbo.json plus one of ${OPENMAPX_DIRS.join(", ")})`,
  );
}

export interface RepoPaths {
  root: string;
  servicesDir: string;
  communityDir: string;
  integrationsDir: string;
  customIntegrationsDir: string;
  infraDir: string;
  composeOutPath: string;
  composeReleasePath: string;
}

export function repoPaths(start?: string): RepoPaths {
  const root = findRepoRoot(start);
  return {
    root,
    servicesDir: join(root, "services"),
    communityDir: join(root, "services", ".community"),
    integrationsDir: join(root, "integrations"),
    customIntegrationsDir: join(root, "custom_integrations"),
    infraDir: join(root, "infra", "docker"),
    composeOutPath: join(root, "infra", "docker", "docker-compose.generated.yml"),
    composeReleasePath: join(root, "infra", "docker", "docker-compose.release.yml"),
  };
}
