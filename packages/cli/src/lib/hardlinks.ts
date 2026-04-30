// CLI-side hardlink apply. The heavy lifting lives in `@openmapx/hardlinks`
// so the data-manager service and this host-side command use the same prune
// semantics. See that package for the sentinel-tracked prune model.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ApplyHardlinkResult,
  applyHardlinkPlan,
  type HardlinkEntry,
} from "@openmapx/hardlinks";
import { repoPaths } from "./paths";

export type { ApplyHardlinkResult, HardlinkEntry };
export { applyHardlinkPlan };

export interface ApplyGeneratedHardlinkOptions {
  rootDir?: string;
  prune?: boolean;
  /**
   * When true, throws if the generated hardlink plan file is missing.
   * Otherwise, returns `applied: false`.
   */
  requirePlan?: boolean;
}

export interface ApplyGeneratedHardlinkResult extends ApplyHardlinkResult {
  applied: boolean;
  entries: number;
  planPath: string;
}

const HARDLINK_PLAN_FILENAME = "docker-compose.generated.hardlinks.json";

export function readGeneratedHardlinkPlan(rootDir?: string): {
  plan: HardlinkEntry[];
  planPath: string;
  dataRoot: string;
} {
  const paths = repoPaths(rootDir);
  const planPath = join(paths.infraDir, HARDLINK_PLAN_FILENAME);
  const parsed = JSON.parse(readFileSync(planPath, "utf-8")) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Hardlink plan at ${planPath} is not an array`);
  }
  return {
    plan: parsed as HardlinkEntry[],
    planPath,
    dataRoot: join(paths.infraDir, "data"),
  };
}

export function applyGeneratedHardlinks(
  opts: ApplyGeneratedHardlinkOptions = {},
): ApplyGeneratedHardlinkResult {
  const paths = repoPaths(opts.rootDir);
  const planPath = join(paths.infraDir, HARDLINK_PLAN_FILENAME);
  if (!existsSync(planPath)) {
    if (opts.requirePlan) {
      throw new Error(`Hardlink plan not found at ${planPath}`);
    }
    return { applied: false, entries: 0, planPath, linked: 0, skipped: 0, pruned: 0 };
  }

  const { plan, dataRoot } = readGeneratedHardlinkPlan(opts.rootDir);
  // Pre-create the host data root as the invoking user so docker doesn't
  // auto-create it as root on first compose up.
  mkdirSync(dataRoot, { recursive: true });
  const result = applyHardlinkPlan(plan, { rootDir: dataRoot, prune: opts.prune });
  return { applied: true, entries: plan.length, planPath, ...result };
}
