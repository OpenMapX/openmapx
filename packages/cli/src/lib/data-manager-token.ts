import { existsSync } from "node:fs";
import { join } from "node:path";
import { readDataManagerToken, readServiceSecretFile } from "@openmapx/core/service-secret-files";
import { repoPaths } from "./paths";

/**
 * The bearer token the CLI presents to the data-manager. The CLI the
 * operations agent runs inherits the agent's `DATA_MANAGER_TOKEN_FILE` and
 * acts with the agent's token. On the host, the CLI reads its own token from
 * `infra/docker/secrets/`, written by `openmapx compose render`. Without that
 * file it has no token, and the data-manager refuses its protected requests.
 *
 * Read on each call: the agent's environment and the rendered file can both
 * appear after the command modules are imported.
 */
export function cliDataManagerToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DATA_MANAGER_TOKEN_FILE?.trim()) return readDataManagerToken(env);
  const path = join(repoPaths().infraDir, "secrets", "data-manager-host-cli-token");
  return existsSync(path) ? readServiceSecretFile(path, "Data-manager host CLI token") : "";
}
