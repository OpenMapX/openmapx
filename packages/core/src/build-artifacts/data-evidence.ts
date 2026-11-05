/** Producer-written data evidence. Status readers inspect metadata, never hash dataset bodies. */
import { createHash } from "node:crypto";
import type { BigIntStats, Stats } from "node:fs";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { z } from "zod";
import { AnchoredDirectory } from "./filesystem";
import { safeArtifactPath } from "./manifest";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  size = z.number().nonnegative().safe();
export const dataFileIdentitySchema = z.strictObject({
  device: z.string().regex(/^\d+$/),
  inode: z.string().regex(/^\d+$/),
  sizeBytes: size,
  modifiedAtMs: z.number().finite().nonnegative(),
  changedAtMs: z.number().finite().nonnegative(),
});
export type DataFileIdentity = z.infer<typeof dataFileIdentitySchema>;
export const osmSourceEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: digest,
  region: z.string().min(1).max(512),
  sha256: digest,
  ...dataFileIdentitySchema.shape,
});
export const osmArtifactId = (sourceId: string) =>
  createHash("sha256").update(`openmapx-osm-v1\0${sourceId}`).digest("hex");
export function fileIdentity(stat: Stats | BigIntStats): DataFileIdentity {
  if (!Number.isSafeInteger(Number(stat.size)))
    throw Error("Data file size exceeds supported inventory");
  return {
    device: String(stat.dev),
    inode: String(stat.ino),
    sizeBytes: Number(stat.size),
    modifiedAtMs: "mtimeNs" in stat ? Number(stat.mtimeNs) / 1e6 : stat.mtimeMs,
    changedAtMs: "ctimeNs" in stat ? Number(stat.ctimeNs) / 1e6 : stat.ctimeMs,
  };
}
export function sameDataFile(left: DataFileIdentity, right: DataFileIdentity) {
  return Object.keys(left).every(
    (key) => left[key as keyof DataFileIdentity] === right[key as keyof DataFileIdentity],
  );
}
export async function hashDataFile(path: string, signal?: AbortSignal) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink < 1) throw Error("Regular data file required");
    const sha = createHash("sha256"),
      md5 = createHash("md5");
    for await (const chunk of createReadStream("", { fd, autoClose: false, signal })) {
      sha.update(chunk);
      md5.update(chunk);
    }
    const after = fstatSync(fd, { bigint: true }),
      named = lstatSync(path, { bigint: true });
    if (
      !sameDataFile(fileIdentity(before), fileIdentity(after)) ||
      !sameDataFile(fileIdentity(after), fileIdentity(named))
    )
      throw Error("Data file changed while hashing");
    return { sha256: sha.digest("hex"), md5: md5.digest("hex"), ...fileIdentity(after) };
  } finally {
    closeSync(fd);
  }
}
export function withDataDirectory<T>(
  dataRoot: string,
  relative: string,
  read: (directory: AnchoredDirectory) => T,
): T {
  if (relative && !safeArtifactPath(relative)) throw Error("Invalid data layout");
  const root = new AnchoredDirectory(dataRoot, undefined, false, true),
    opened = [root];
  let current = root;
  try {
    for (const component of relative ? relative.split("/") : []) {
      current = new AnchoredDirectory(current.name(component), current, false, true);
      opened.push(current);
    }
    return read(current);
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
export function inspectDataFile(dataRoot: string, relative: string): DataFileIdentity {
  const parts = relative.split("/"),
    name = parts.pop();
  if (!name || !safeArtifactPath(relative)) throw Error("Invalid data file");
  return withDataDirectory(dataRoot, parts.join("/"), (directory) => {
    const path = directory.name(name),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink < 1 || (before.mode & 0o022n) !== 0n)
        throw Error("Unsafe data file");
      directory.check();
      const after = fstatSync(fd, { bigint: true }),
        named = lstatSync(path, { bigint: true });
      if (
        !sameDataFile(fileIdentity(before), fileIdentity(after)) ||
        !sameDataFile(fileIdentity(after), fileIdentity(named))
      )
        throw Error("Data file changed during inspection");
      return fileIdentity(after);
    } finally {
      closeSync(fd);
    }
  });
}

export async function withDataDirectoryAsync<T>(
  dataRoot: string,
  relative: string,
  read: (directory: AnchoredDirectory) => Promise<T>,
): Promise<T> {
  if (relative && !safeArtifactPath(relative)) throw Error("Invalid data layout");
  const root = new AnchoredDirectory(dataRoot, undefined, false, true),
    opened = [root];
  let current = root;
  try {
    for (const component of relative ? relative.split("/") : []) {
      current = new AnchoredDirectory(current.name(component), current, false, true);
      opened.push(current);
    }
    return await read(current);
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
