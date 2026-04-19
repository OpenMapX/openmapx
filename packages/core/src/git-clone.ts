// packages/core/src/git-clone.ts
//
// Shared `git clone --depth 1` helper used by both the community-service
// repository registrar (`apps/api/src/services/service-repositories.ts`) and
// the community-integration installer (`integration/installer.ts`). Both
// consumers want the same thing — atomic shallow clone into a per-call tmp
// directory, then rename into the final destination — and previously had two
// independent implementations (one using `simple-git`, one using raw `spawn`).

import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnWithBufferedLogs } from "./spawn";

export interface GitShallowCloneOptions {
  url: string;
  /** Branch or tag (--branch). Optional. */
  ref?: string;
  signal?: AbortSignal;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

/**
 * Clone `url` into a fresh tmp directory and return its path. Caller owns the
 * tmp directory afterwards: rename it into place, validate it, or remove it
 * on error. The clone is shallow (--depth 1) and the .git directory is
 * removed so the result is a snapshot, not a working tree.
 */
export async function gitShallowClone(opts: GitShallowCloneOptions): Promise<string> {
  const tmp = join(tmpdir(), `openmapx-git-${randomBytes(4).toString("hex")}`);
  try {
    const args = ["clone", "--depth", "1"];
    if (opts.ref) args.push("--branch", opts.ref);
    args.push(opts.url, tmp);
    await spawnWithBufferedLogs("git", args, { signal: opts.signal, onLog: opts.onLog });
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    return tmp;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Atomic clone-then-rename: clones to a tmp dir, then `renameSync` into
 * `finalTarget`. If `finalTarget` already exists it is replaced atomically.
 * Two callers concurrently submitting the same URL each get their own tmp
 * dir; the second rename simply replaces the first — no torn state.
 */
export async function gitShallowCloneAtomic(
  opts: GitShallowCloneOptions & { finalTarget: string },
): Promise<void> {
  const tmp = await gitShallowClone(opts);
  if (existsSync(opts.finalTarget)) {
    rmSync(opts.finalTarget, { recursive: true, force: true });
  }
  renameSync(tmp, opts.finalTarget);
}
