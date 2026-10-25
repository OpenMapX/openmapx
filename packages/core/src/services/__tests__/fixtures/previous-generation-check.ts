import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * `safeGenerationTree` exactly as the release before release-owned service
 * files shipped it (packages/core/src/services/configuration-generation.ts at
 * d4da20793), with the constants it reads. A rollback to that release runs it
 * on every generation this one writes, and reads no `current` it refuses.
 * Kept verbatim, not imported, so a change to today's check cannot hide a
 * generation the previous release would refuse.
 */
const GENERATED_SECRETS_DIRNAME = ".generated-secrets";
const MAX_GENERATION_BYTES = 2 * 1024 * 1024;
const UNSAFE = "Configuration generation is not owned by this user or has unsafe permissions";

export function safeGenerationTree(path: string): { entries: number; bytes: number } {
  const owner = process.geteuid?.() ?? 0;
  const rootStats = lstatSync(path);
  if (
    !rootStats.isDirectory() ||
    rootStats.isSymbolicLink() ||
    rootStats.uid !== owner ||
    (rootStats.mode & 0o777) !== 0o700
  ) {
    throw new Error(UNSAFE);
  }
  let entries = 1;
  let bytes = 0;
  // Secret files are 0444 inside their 0700 directories (see
  // commitConfigurationGeneration); every other generated file is private.
  const visit = (directory: string, secrets: boolean) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > 1024) throw new Error(UNSAFE);
      const child = join(directory, entry.name);
      const stats = lstatSync(child);
      if (stats.uid !== owner || stats.isSymbolicLink()) throw new Error(UNSAFE);
      if (stats.isDirectory()) {
        if ((stats.mode & 0o777) !== 0o700) throw new Error(UNSAFE);
        visit(child, secrets || (directory === path && entry.name === GENERATED_SECRETS_DIRNAME));
      } else if (stats.isFile()) {
        const modes = secrets ? [0o444] : [0o400, 0o600];
        if (stats.nlink !== 1 || !modes.includes(stats.mode & 0o777)) throw new Error(UNSAFE);
        bytes += stats.size;
      } else throw new Error(UNSAFE);
      if (bytes > MAX_GENERATION_BYTES) throw new Error(UNSAFE);
    }
  };
  visit(path, false);
  return { entries, bytes };
}
