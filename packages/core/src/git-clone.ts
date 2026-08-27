// Shared bounded Git snapshot helper used by the community-service repository
// registrar and community-integration installer.
//
// Every clone here is of untrusted, admin-supplied content, so the URL is
// validated inside this module (no caller can opt out) and the checkout is
// bounded by time, entry count, total bytes, per-file bytes, path length, and
// file type before anything is allowed to use it.

import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { assertAllowedGitUrl } from "./git-url";
import { spawnWithBufferedLogs } from "./spawn";

/** Wall-clock ceiling for one clone, composed with the caller's signal. */
export const GIT_CLONE_TIMEOUT_MS = 120_000;
export const GIT_CLONE_MAX_ENTRIES = 25_000;
export const GIT_CLONE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const GIT_CLONE_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const GIT_CLONE_MAX_PATH_BYTES = 512;

export class GitCloneQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCloneQuotaError";
  }
}

const GIT_TREE_ENTRY = /^([0-7]{6}) (\S+) [a-f0-9]{40,64}\s+(\d+|-)\t(.+)$/;

/**
 * Enforce blob budgets from `git ls-tree -rl --full-tree` before checkout.
 * This prevents an oversized blob from reaching the working tree first and
 * only being noticed by the post-checkout filesystem walk.
 */
export function assertGitTreeMetadataWithinBudget(lines: Iterable<string>): void {
  let entries = 0;
  let totalBytes = 0;
  for (const line of lines) {
    const match = GIT_TREE_ENTRY.exec(line);
    if (!match) throw new GitCloneQuotaError("Repository tree metadata is malformed");
    const [, mode, type, rawSize, path] = match;
    entries += 1;
    if (entries > GIT_CLONE_MAX_ENTRIES) {
      throw new GitCloneQuotaError(`Repository exceeds the ${GIT_CLONE_MAX_ENTRIES}-entry limit`);
    }
    if (!path || Buffer.byteLength(path, "utf8") > GIT_CLONE_MAX_PATH_BYTES) {
      throw new GitCloneQuotaError(
        `Repository contains a path longer than ${GIT_CLONE_MAX_PATH_BYTES} bytes`,
      );
    }
    // Ordinary files and executables only. This rejects symlinks (120000),
    // submodules (160000), and any future special mode before checkout.
    if (type !== "blob" || (mode !== "100644" && mode !== "100755") || rawSize === "-") {
      throw new GitCloneQuotaError(`Repository contains an unsupported entry type at ${path}`);
    }
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GitCloneQuotaError("Repository tree contains an invalid blob size");
    }
    if (size > GIT_CLONE_MAX_FILE_BYTES) {
      throw new GitCloneQuotaError(
        `Repository contains a file larger than ${GIT_CLONE_MAX_FILE_BYTES} bytes at ${path}`,
      );
    }
    totalBytes += size;
    if (totalBytes > GIT_CLONE_MAX_TOTAL_BYTES) {
      throw new GitCloneQuotaError(
        `Repository exceeds the ${GIT_CLONE_MAX_TOTAL_BYTES}-byte limit`,
      );
    }
  }
}

function safeGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ALLOW_PROTOCOL: "https",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function assertSafeGitRef(ref: string): void {
  const hasForbiddenCharacter = [...ref].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
  });
  if (
    ref.length === 0 ||
    ref.length > 255 ||
    ref.startsWith("-") ||
    hasForbiddenCharacter ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("//") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => part === "." || part.endsWith(".lock"))
  ) {
    throw new Error("Repository ref is not a safe branch, tag, or commit name");
  }
}

export interface GitShallowCloneOptions {
  url: string;
  /** Branch, tag, or commit. Optional. */
  ref?: string;
  /** Optional destination directory. Defaults to a fresh directory under OS tmp. */
  targetDir?: string;
  signal?: AbortSignal;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

/**
 * Walk the checkout with `lstat` (never following a link) and enforce the size,
 * count, path, and file-type budget. `.git` is skipped: it is the clone's own
 * metadata, is not part of the published snapshot, and is removed by the caller
 * or by this helper.
 */
export function assertCloneWithinBudget(root: string): void {
  let entries = 0;
  let totalBytes = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const directory = stack.pop() as string;
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const relativePath = relative(root, absolute);
      if (relativePath === ".git" || relativePath.startsWith(`.git${sep}`)) {
        continue;
      }
      entries += 1;
      if (entries > GIT_CLONE_MAX_ENTRIES) {
        throw new GitCloneQuotaError(`Repository exceeds the ${GIT_CLONE_MAX_ENTRIES}-entry limit`);
      }
      if (Buffer.byteLength(relativePath, "utf8") > GIT_CLONE_MAX_PATH_BYTES) {
        throw new GitCloneQuotaError(
          `Repository contains a path longer than ${GIT_CLONE_MAX_PATH_BYTES} bytes`,
        );
      }
      const stats = lstatSync(absolute);
      if (stats.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!stats.isFile()) {
        // Symlinks, sockets, devices, and FIFOs are refused outright: a link can
        // point outside the snapshot once it is renamed into a managed tree.
        throw new GitCloneQuotaError(
          `Repository contains an unsupported entry type at ${relativePath}`,
        );
      }
      if (stats.size > GIT_CLONE_MAX_FILE_BYTES) {
        throw new GitCloneQuotaError(
          `Repository contains a file larger than ${GIT_CLONE_MAX_FILE_BYTES} bytes at ${relativePath}`,
        );
      }
      totalBytes += stats.size;
      if (totalBytes > GIT_CLONE_MAX_TOTAL_BYTES) {
        throw new GitCloneQuotaError(
          `Repository exceeds the ${GIT_CLONE_MAX_TOTAL_BYTES}-byte limit`,
        );
      }
    }
  }
}

export interface GitShallowCloneResult {
  /** The checkout directory. */
  directory: string;
  /** Credential-free canonical URL that was cloned. */
  canonicalUrl: string;
  /** The exact commit that was checked out. */
  commit: string;
}

/**
 * Clone `url` into a fresh tmp directory and return its path. Caller owns the
 * tmp directory afterwards: rename it into place, validate it, or remove it
 * on error. The clone is shallow and the .git directory is removed so the
 * result is a snapshot, not a working tree.
 */
export async function gitShallowClone(opts: GitShallowCloneOptions): Promise<string> {
  return (await gitShallowCloneSnapshot(opts)).directory;
}

/**
 * The full form: validates the URL, bounds the clone, and reports the exact
 * commit alongside the canonical URL so callers can record provenance.
 */
export async function gitShallowCloneSnapshot(
  opts: GitShallowCloneOptions,
): Promise<GitShallowCloneResult> {
  // Validated here rather than at each call site so no caller can bypass it.
  const allowed = assertAllowedGitUrl(opts.url);
  const tmp = opts.targetDir ?? join(tmpdir(), `openmapx-git-${randomBytes(4).toString("hex")}`);
  if (existsSync(tmp)) throw new Error("Clone target already exists");
  if (opts.ref !== undefined) assertSafeGitRef(opts.ref);
  const timeout = AbortSignal.timeout(GIT_CLONE_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const env = safeGitEnvironment();
  try {
    await spawnWithBufferedLogs("git", ["init", "--initial-branch=openmapx-empty", tmp], {
      signal,
      env,
      displayCommand: "git init",
    });
    await spawnWithBufferedLogs("git", ["-C", tmp, "remote", "add", "origin", allowed.canonical], {
      signal,
      env,
      displayCommand: `git remote add ${allowed.hostname}`,
    });
    await spawnWithBufferedLogs(
      "git",
      [
        "-C",
        tmp,
        "fetch",
        "--depth=1",
        "--no-tags",
        "--filter=blob:none",
        "origin",
        opts.ref ?? "HEAD",
      ],
      {
        signal,
        env,
        onLog: opts.onLog,
        displayCommand: `git fetch ${allowed.hostname}`,
      },
    );

    // Resolve the exact commit while `.git` still exists.
    let commit = "";
    await spawnWithBufferedLogs("git", ["-C", tmp, "rev-parse", "FETCH_HEAD"], {
      signal,
      env,
      displayCommand: "git rev-parse",
      onLog: (line, stream) => {
        if (stream === "stdout" && /^[a-f0-9]{40}$/.test(line.trim())) commit = line.trim();
      },
    });
    if (!/^[a-f0-9]{40}$/.test(commit)) {
      throw new Error("Could not resolve the cloned commit");
    }

    const treeLines: string[] = [];
    let treeOverflow = false;
    await spawnWithBufferedLogs("git", ["-C", tmp, "ls-tree", "-rl", "--full-tree", "FETCH_HEAD"], {
      signal,
      env,
      displayCommand: "git ls-tree",
      onLog: (line, stream) => {
        if (stream === "stderr") {
          opts.onLog?.(line, stream);
        } else if (treeLines.length <= GIT_CLONE_MAX_ENTRIES) {
          treeLines.push(line);
        } else {
          treeOverflow = true;
        }
      },
    });
    if (treeOverflow) {
      throw new GitCloneQuotaError(`Repository exceeds the ${GIT_CLONE_MAX_ENTRIES}-entry limit`);
    }
    assertGitTreeMetadataWithinBudget(treeLines);

    // Checkout happens only after the remote tree proves that every blob is
    // within budget. Global/system Git configuration is disabled so a tracked
    // `.gitattributes` file cannot select an operator-installed external filter.
    await spawnWithBufferedLogs(
      "git",
      ["-C", tmp, "checkout", "--detach", "--force", "FETCH_HEAD"],
      {
        signal,
        env,
        onLog: opts.onLog,
        displayCommand: "git checkout",
      },
    );
    assertCloneWithinBudget(tmp);
    rmSync(join(tmp, ".git"), { recursive: true, force: true });
    return { directory: tmp, canonicalUrl: allowed.canonical, commit };
  } catch (err) {
    // Timeout, quota failure, validation failure, and abort all remove the tree.
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
