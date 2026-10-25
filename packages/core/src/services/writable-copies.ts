import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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

function replaceWith(path: string, bytes: Buffer): void {
  const temporary = join(dirname(path), `.${randomBytes(6).toString("hex")}.seed.tmp`);
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
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDirectory(dirname(path));
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
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      let current: ReturnType<typeof lstatSync> | undefined;
      try {
        current = lstatSync(path);
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
      replaceWith(path, seed.bytes);
      next[key] = seed.sha256;
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
