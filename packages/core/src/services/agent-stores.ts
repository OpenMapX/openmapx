import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { agentStatePaths } from "./agent-state";

/**
 * A directory of this user's own, kept owner-only; anything else there,
 * a file, a link or another user's directory, is refused.
 */
function ensureStoreDirectory(path: string, uid: number): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== uid) {
    throw new Error(`The agent's store at ${path} is not its own directory`);
  }
  chmodSync(path, 0o700);
}

/**
 * Makes sure the operations agent's two stores, the community service
 * repositories and the installed integrations, exist in its state directory,
 * owner-only, before a configuration generation mounts one of them. Run
 * under the configuration writer lock.
 */
export function prepareAgentStores(infraDir: string, options: { uid?: number } = {}): void {
  const uid = options.uid ?? process.geteuid?.() ?? 0;
  const paths = agentStatePaths(infraDir);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  ensureStoreDirectory(paths.community, uid);
  ensureStoreDirectory(paths.customIntegrations, uid);
}
