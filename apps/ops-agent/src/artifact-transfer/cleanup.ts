/** Descriptor-confined cleanup of settled private staging data. Never follows links. */
import { fsyncSync, lstatSync, rmdirSync } from "node:fs";
import type { AnchoredDirectory } from "@openmapx/core/build-artifacts";

type FileIdentity = { dev: string; ino: string };
const identity = (stat: { dev: bigint; ino: bigint }): FileIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
});
const sameInode = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;

export interface StageCleanupEntry {
  name: string;
  inode: FileIdentity;
  children: StageCleanupEntry[] | null;
}

/** Inspect the complete tree before removing any bytes. An unexpected link or
 * oversized tree must leave the upload and every other extraction intact. */
export function inspectStageCleanup(
  directory: AnchoredDirectory,
  budget: { remaining: number; maxDepth: number },
  depth = 0,
): StageCleanupEntry[] {
  if (depth > budget.maxDepth) throw Error("Artifact cleanup depth limit exceeded");
  return directory
    .listBounded(budget.remaining)
    .sort()
    .map((name) => {
      if (--budget.remaining < 0) throw Error("Artifact cleanup entry limit exceeded");
      const stat = lstatSync(directory.name(name), { bigint: true });
      if (stat.isDirectory()) {
        const child = directory.directory(name, false, false);
        try {
          if (!sameInode(identity(stat), identity(child.stat)))
            throw Error("Artifact cleanup directory changed");
          return {
            name,
            inode: identity(child.stat),
            children: inspectStageCleanup(child, budget, depth + 1),
          };
        } finally {
          child.close();
        }
      }
      return { name, inode: directory.fileIdentity(name, false), children: null };
    });
}

export function removeStageCleanup(
  directory: AnchoredDirectory,
  entries: StageCleanupEntry[],
): void {
  for (const entry of entries) {
    if (entry.children === null) {
      if (!sameInode(entry.inode, directory.fileIdentity(entry.name, false)))
        throw Error("Artifact cleanup file changed");
      directory.removeFile(entry.name);
    } else {
      const child = directory.directory(entry.name, false, false);
      try {
        if (!sameInode(entry.inode, identity(child.stat)))
          throw Error("Artifact cleanup directory changed");
        removeStageCleanup(child, entry.children);
        child.check();
        if (child.hasEntries()) throw Error("Artifact cleanup directory gained content");
        rmdirSync(directory.name(entry.name));
        fsyncSync(directory.fd);
      } finally {
        child.close();
      }
    }
  }
}
