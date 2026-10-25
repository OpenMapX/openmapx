import { existsSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { repoPaths } from "./paths";

/**
 * Populate `process.env` with values from `infra/docker/.env` if the file
 * exists. Shell env values take precedence (Node's built-in loader doesn't
 * overwrite existing keys).
 *
 * Matches Docker Compose's own behaviour: `docker compose up` auto-loads the
 * `.env` next to the compose file. Mirroring it here keeps `pnpm openmapx
 * compose render` in sync — the operator sets `DOMAIN=` once in `infra/docker/.env`
 * and both sides see it, without needing to `export DOMAIN=...` in the shell.
 *
 * Only the operator's own file is read: one anyone else could have written is
 * left unread here, and rendering, stack commands and `check` refuse it with
 * the reason.
 */
export function loadInfraEnv(rootDir?: string): void {
  try {
    const paths = repoPaths(rootDir);
    const envFile = join(paths.infraDir, ".env");
    if (existsSync(envFile) && !coreServices.deploymentEnvironmentFileProblem(envFile)) {
      process.loadEnvFile(envFile);
    }
  } catch {
    // Pre-render calls from outside the repo root (e.g. a global install)
    // can't resolve the infra dir — that's fine, callers then rely on
    // shell env + explicit flags.
  }
}
