import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { log } from "./output";

/**
 * Builds write into a sibling `<dir>.next` and only replace the live producer
 * dir once the build has fully succeeded, so a failed or interrupted build
 * leaves the previous artifact intact. The swap is two renames on the same
 * filesystem; consumers see the new inodes after the post-build hardlink pass.
 */
export function stagedBuildDir(liveDir: string): string {
  return `${liveDir}.next`;
}

function previousBuildDir(liveDir: string): string {
  return `${liveDir}.prev`;
}

/**
 * Clear leftovers from an earlier run before any work starts, so a stale dir
 * that can't be removed fails the build up front rather than after it.
 */
export function prepareStagedBuildDir(liveDir: string): string {
  const nextDir = stagedBuildDir(liveDir);
  rmSync(previousBuildDir(liveDir), { recursive: true, force: true });
  rmSync(nextDir, { recursive: true, force: true });
  mkdirSync(nextDir, { recursive: true });
  return nextDir;
}

export interface StagedSwap {
  liveDir: string;
  nextDir: string;
}

/**
 * Swap every staged dir over its live dir as one unit: all live dirs move to
 * `.prev`, then all staged dirs into place. Any failure restores every live
 * dir. Removing the old copies afterwards is best-effort, since the new
 * artifact is already live by then.
 */
export function promoteStagedBuildDirs(swaps: readonly StagedSwap[]): void {
  const moved: StagedSwap[] = [];
  const installed: StagedSwap[] = [];
  try {
    for (const swap of swaps) {
      rmSync(previousBuildDir(swap.liveDir), { recursive: true, force: true });
      if (existsSync(swap.liveDir)) {
        renameSync(swap.liveDir, previousBuildDir(swap.liveDir));
        moved.push(swap);
      }
    }
    for (const swap of swaps) {
      renameSync(swap.nextDir, swap.liveDir);
      installed.push(swap);
    }
  } catch (error) {
    for (const swap of installed.reverse()) renameSync(swap.liveDir, swap.nextDir);
    for (const swap of moved.reverse()) renameSync(previousBuildDir(swap.liveDir), swap.liveDir);
    throw error;
  }
  for (const swap of moved) {
    const prevDir = previousBuildDir(swap.liveDir);
    try {
      rmSync(prevDir, { recursive: true, force: true });
    } catch (error) {
      log.warn(
        `New artifact is live, but the old copy at ${prevDir} could not be removed: ${(error as Error).message}`,
      );
    }
  }
}

export function promoteStagedBuildDir(liveDir: string, nextDir: string): void {
  promoteStagedBuildDirs([{ liveDir, nextDir }]);
}

/**
 * Run `build` against a fresh `<liveDir>.next`, then promote it over
 * `liveDir`. On failure the staged dir is removed and `liveDir` is untouched.
 */
export async function withStagedBuildDir<T>(
  liveDir: string,
  build: (nextDir: string) => Promise<T>,
): Promise<T> {
  const nextDir = prepareStagedBuildDir(liveDir);
  let result: T;
  try {
    result = await build(nextDir);
  } catch (error) {
    rmSync(nextDir, { recursive: true, force: true });
    throw error;
  }
  promoteStagedBuildDir(liveDir, nextDir);
  return result;
}
