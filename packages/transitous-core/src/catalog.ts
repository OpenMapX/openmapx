import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner } from "./runner.js";

/**
 * Inline `safe.directory` git config. The catalog clone may be owned by the
 * data-manager container UID while an operator runs the CLI as a different UID;
 * modern git refuses to touch a repo with mismatched ownership otherwise.
 */
export function safeDirArgs(catalogDir: string): string[] {
  return ["-c", `safe.directory=${catalogDir}`];
}

/** Discard any in-place edits to the catalog working tree. Best-effort. */
export async function resetCatalog(catalogDir: string, runner: CommandRunner): Promise<void> {
  try {
    await runner("git", [...safeDirArgs(catalogDir), "-C", catalogDir, "reset", "--hard", "HEAD"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch {
    // Best effort only.
  }
}

export interface EnsureCatalogOptions {
  /** Dir the git commands run from (cwd). */
  dataDir: string;
  /** Target catalog working-tree path. */
  catalogDir: string;
  /** Repo to clone when the catalog isn't present yet. */
  repoUrl: string;
  runner: CommandRunner;
  /** Git stdio. CLI uses "inherit" for operator visibility; daemon uses "pipe". */
  stdio?: "inherit" | "pipe";
  /** Reset --hard before pulling (daemon discards prior in-place skip edits). */
  reset?: boolean;
}

/**
 * Clone the Transitous catalog if absent, otherwise update it in place
 * (optionally reset first, then `pull --ff-only` + submodule update). Shallow
 * clone + shallow submodules. Returns the catalog dir. The pull is best-effort:
 * a failed refresh keeps the cached checkout rather than erroring.
 *
 * Lock enforcement (pinning to a recorded SHA) is intentionally NOT here — it's
 * a daemon-only concern layered on top by the caller.
 */
export async function ensureCatalog(opts: EnsureCatalogOptions): Promise<string> {
  const { dataDir, catalogDir, repoUrl, runner } = opts;
  const stdio = opts.stdio ?? "pipe";
  const safe = safeDirArgs(catalogDir);

  if (existsSync(join(catalogDir, ".git"))) {
    if (opts.reset) await resetCatalog(catalogDir, runner);
    try {
      await runner("git", [...safe, "-C", catalogDir, "pull", "--ff-only"], {
        cwd: dataDir,
        stdio,
      });
    } catch {
      // Keep using the cached checkout if the upstream refresh fails.
    }
    await runner(
      "git",
      [...safe, "-C", catalogDir, "submodule", "update", "--init", "--checkout", "--depth", "1"],
      { cwd: dataDir, stdio },
    );
    return catalogDir;
  }

  rmSync(catalogDir, { recursive: true, force: true });
  await runner(
    "git",
    [
      ...safe,
      "clone",
      "--depth",
      "1",
      "--recurse-submodules",
      "--shallow-submodules",
      // `--` terminates option parsing so a repoUrl starting with `-` can't be
      // read by git as a flag (argument injection).
      "--",
      repoUrl,
      catalogDir,
    ],
    { cwd: dataDir, stdio },
  );
  return catalogDir;
}
