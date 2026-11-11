import { join } from "node:path";

/**
 * The operator's Transitous API keys live alone in this directory, relative to
 * `infra/docker`. data-manager's manifest mounts it read-only at
 * `/config/transitous`, where it reads `api-keys.json` at every run. A
 * directory, not the file: a file mount would keep showing the file a rename
 * replaced until the container is recreated.
 */
export const TRANSITOUS_API_KEYS_DIRECTORY = "secrets/transitous-api-keys";
export const TRANSITOUS_API_KEYS_FILENAME = "api-keys.json";

export function transitousApiKeysDirectory(infraDir: string): string {
  return join(infraDir, ...TRANSITOUS_API_KEYS_DIRECTORY.split("/"));
}

export function transitousApiKeysPath(infraDir: string): string {
  return join(transitousApiKeysDirectory(infraDir), TRANSITOUS_API_KEYS_FILENAME);
}
