import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import z from "zod/v4";
import { atomicWrite, fsyncDirectory } from "../release-files";
import { agentStatePaths } from "./agent-state";
import type { WritableCopySeed } from "./service-file-store";

/**
 * The writable copies of files a container rewrites (`writableCopy` in its
 * manifest, valhalla.json): `infra/docker/data/...`, seeded from the
 * release's file or the operator's override. A copy is seeded when it is
 * missing and again whenever its seed changes, which the agent's state
 * records; in between, the container's rewrite is kept. A running container
 * keeps the file it mounted, so a new seed reaches it when it next starts.
 */

const recordSchema = z.strictObject({
  version: z.literal(1),
  seeds: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
});

function recordPath(infraDir: string): string {
  return join(agentStatePaths(infraDir).directory, "writable-copies.json");
}

function readRecord(infraDir: string): Record<string, string> {
  try {
    return recordSchema.parse(JSON.parse(readFileSync(recordPath(infraDir), "utf8"))).seeds;
  } catch {
    // Missing or unreadable: every copy is seeded again.
    return {};
  }
}

/** The host path of a `@infra:data/...` copy. */
export function writableCopyPath(infraDir: string, copy: string): string {
  return resolve(infraDir, copy.slice("@infra:".length));
}

/** The copy's directory, held so that names in it resolve there and nowhere else. */
interface CopyDirectory {
  /** A path naming `name` in the held directory. */
  at(name: string): string;
  /** Whether the held directory is still the one the copy's path names. */
  intact(): boolean;
  sync(): void;
  close(): void;
}

/**
 * Opens (creating them) the copy's directories below `infra/docker/data`,
 * each a real directory, never through a link: containers write the data
 * directory, and one could plant a link to steer render's write elsewhere.
 * On Linux each is opened relative to the one above it, through
 * `/proc/self/fd`, so swapping one for a link afterwards changes nothing;
 * elsewhere (development) the path is checked again before the rename. (The
 * data directory itself may be the operator's link to another disk; no
 * container mounts its parent.)
 */
function openCopyDirectory(infraDir: string, path: string): CopyDirectory {
  const data = join(infraDir, "data");
  const below = relative(data, dirname(path));
  const parts = below.split(sep);
  if (!below || parts[0] === ".." || isAbsolute(below)) {
    throw new Error("it is not below infra/docker/data");
  }
  mkdirSync(data, { recursive: true });
  const descriptors = existsSync("/proc/self/fd");
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = descriptors ? openSync(data, constants.O_RDONLY | constants.O_DIRECTORY) : -1;
  let directory = data;
  try {
    for (const part of parts) {
      const next = descriptors ? `/proc/self/fd/${fd}/${part}` : join(directory, part);
      directory = join(directory, part);
      try {
        mkdirSync(next, { mode: 0o755 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      // Opening it is the check: a link or anything but a directory fails.
      let child: number;
      try {
        child = openSync(next, directoryFlags);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ELOOP" || code === "ENOTDIR") {
          throw new Error(`${relative(infraDir, directory)} is not a directory`);
        }
        throw error;
      }
      if (descriptors) {
        closeSync(fd);
        fd = child;
      } else {
        closeSync(child);
      }
    }
  } catch (error) {
    if (fd >= 0) closeSync(fd);
    throw error;
  }
  if (descriptors) {
    const held = fd;
    return {
      at: (name) => `/proc/self/fd/${held}/${name}`,
      intact: () => true,
      sync: () => fsyncSync(held),
      close: () => closeSync(held),
    };
  }
  const resolved = directory;
  return {
    at: (name) => join(resolved, name),
    intact: () => realpathSync(resolved) === join(realpathSync(data), below),
    sync: () => fsyncDirectory(resolved),
    close: () => undefined,
  };
}

function replaceWith(directory: CopyDirectory, name: string, bytes: Buffer): void {
  const temporary = directory.at(`.${randomBytes(6).toString("hex")}.seed.tmp`);
  const fd = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fchmodSync(fd, 0o644);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    // The rename replaces the entry itself, never what a link points at.
    if (!directory.intact()) throw new Error("a directory on its path is a link");
    renameSync(temporary, directory.at(name));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  directory.sync();
}

/** Seeds each copy whose seed changed; returns what render reports about those it could not. */
export function seedWritableCopies(infraDir: string, seeds: readonly WritableCopySeed[]): string[] {
  if (seeds.length === 0) return [];
  const recorded = readRecord(infraDir);
  const next = { ...recorded };
  const problems: string[] = [];
  for (const seed of seeds) {
    const path = writableCopyPath(infraDir, seed.copy);
    const key = `${seed.serviceId}/${seed.path}`;
    const shown = relative(infraDir, path);
    try {
      const directory = openCopyDirectory(infraDir, path);
      try {
        let current: ReturnType<typeof lstatSync> | undefined;
        try {
          current = lstatSync(directory.at(basename(path)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (current && !current.isFile()) {
          problems.push(
            `infra/docker/${shown}, the writable copy of services/${key}, is not a regular file (Docker creates a missing one as a directory). Remove it and render again.`,
          );
          continue;
        }
        if (current && recorded[key] === seed.sha256) continue;
        replaceWith(directory, basename(path), seed.bytes);
        next[key] = seed.sha256;
      } finally {
        directory.close();
      }
    } catch (error) {
      problems.push(
        `infra/docker/${shown}, the writable copy of services/${key}, could not be written: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}. ${seed.serviceId} keeps its current copy.`,
      );
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(recorded)) {
    atomicWrite(recordPath(infraDir), `${JSON.stringify({ version: 1, seeds: next })}\n`);
  }
  return problems;
}
