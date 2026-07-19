import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { parseRefShaPair, type TransitousLock } from "../../transitous-lock.js";

/**
 * Minimal command-runner seam so the resolver can be unit-tested without
 * shelling out to git. Production callers use the default (execa).
 */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

const defaultRunner: CommandRunner = (file, args) => execa(file, args, { stdio: "pipe" });

/** A resolved upstream catalog pin: the transitous ref plus its transitland-atlas submodule. */
export interface CatalogBumpCandidate {
  branch: string;
  /** `<branch>@<sha>` — the shape `transitous.lock.json.ref` stores. */
  ref: string;
  transitousSha: string;
  transitlandAtlasSha: string;
}

/** Machine-readable failure so HTTP callers can map to status codes and the cron can log a code. */
export class CatalogBumpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CatalogBumpError";
  }
}

export interface ResolveCatalogBumpOptions {
  /** The already-cloned Transitous catalog working copy. */
  catalogDir: string;
  /** Branch to track. Defaults to "main". */
  branch?: string;
  runner?: CommandRunner;
}

/**
 * Fetch `origin/<branch>` in the catalog clone and resolve the tip commit plus
 * the `transitland-atlas` submodule gitlink it points at. Both together define
 * a reproducible catalog pin. Throws {@link CatalogBumpError} with a code on
 * every failure so callers surface an actionable reason.
 *
 * This is the single source of truth shared by the `POST /transit/bump` route
 * and the auto-bump cron.
 */
export async function resolveCatalogBumpCandidate(
  opts: ResolveCatalogBumpOptions,
): Promise<CatalogBumpCandidate> {
  const branch = opts.branch?.trim() || "main";
  const runner = opts.runner ?? defaultRunner;
  const { catalogDir } = opts;

  if (!existsSync(join(catalogDir, ".git"))) {
    throw new CatalogBumpError(
      "catalog-not-cloned",
      `Transitous catalog not found at ${catalogDir}; run a sync first to clone it.`,
    );
  }

  try {
    await runner("git", ["-C", catalogDir, "fetch", "origin", branch]);
  } catch (err) {
    throw new CatalogBumpError("git-fetch-failed", (err as Error).message);
  }

  const transitousSha = (
    await runner("git", ["-C", catalogDir, "rev-parse", `origin/${branch}`])
  ).stdout.trim();

  // `git ls-tree <ref> <path>` returns "<mode> commit <sha>\t<path>" for a
  // submodule entry; rev-parse on the same ref:path would resolve a tree.
  const submoduleEntry = (
    await runner("git", ["-C", catalogDir, "ls-tree", `origin/${branch}`, "transitland-atlas"])
  ).stdout;
  const match = submoduleEntry.match(/^\d+\s+commit\s+([0-9a-f]{40})\s/i);
  if (!match) {
    throw new CatalogBumpError(
      "submodule-resolution-failed",
      "Could not resolve transitland-atlas submodule SHA",
    );
  }

  return {
    branch,
    ref: `${branch}@${transitousSha}`,
    transitousSha,
    transitlandAtlasSha: match[1],
  };
}

/** True when the active lock already pins this exact transitous SHA + atlas submodule. */
export function candidateMatchesLock(
  candidate: CatalogBumpCandidate,
  lock: TransitousLock | null,
): boolean {
  if (!lock) return false;
  const currentSha = parseRefShaPair(lock.ref).sha;
  return (
    currentSha === candidate.transitousSha &&
    lock.submodules["transitland-atlas"] === candidate.transitlandAtlasSha
  );
}

/** Materialise a `TransitousLock` from a resolved candidate. */
export function lockFromCandidate(
  candidate: CatalogBumpCandidate,
  lockedBy: string,
  comment: string,
): TransitousLock {
  return {
    ref: candidate.ref,
    submodules: { "transitland-atlas": candidate.transitlandAtlasSha },
    lockedAt: new Date().toISOString(),
    lockedBy,
    comment,
  };
}
