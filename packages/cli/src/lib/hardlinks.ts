// CLI-side hardlink apply. Two paths:
//
//   1. Preferred — POST the plan to the data-manager's `/link` endpoint.
//      The data-manager runs inside its container as the same UID that
//      writes /data, so it can hardlink across files the host CLI user
//      doesn't own. With Linux's `fs.protected_hardlinks=1` (the default
//      on most distros) the host-side `linkSync` returns EPERM the moment
//      a producer container has touched the source file, even if the file
//      is world-readable.
//
//   2. Fallback — if the data-manager isn't reachable (typical on the very
//      first `compose up` before any container has started), do the link
//      with `linkSync` directly. The plan is usually empty in that
//      situation because no data has been produced yet.
//
// `@openmapx/hardlinks` provides the shared low-level planner used by both
// the data-manager service (`POST /link` inside the container) and the
// fallback path here, so the prune semantics stay identical regardless of
// which side actually creates the links.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import {
  type ApplyHardlinkResult,
  applyHardlinkPlan,
  type HardlinkEntry,
} from "@openmapx/hardlinks";
import { repoPaths } from "./paths";

const { DataManagerClient } = coreServices;

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
  /**
   * Override the data-manager URL. Defaults to `DATA_MANAGER_URL` from the
   * environment, falling back to `http://localhost:4000`.
   */
  dataManagerUrl?: string;
  /**
   * Hard-skip the data-manager API path. Useful in tests + situations where
   * the operator knows the API isn't reachable and wants to avoid the
   * connect-attempt latency. Defaults to false.
   */
  forceLocal?: boolean;
  /**
   * Connect-attempt timeout for the data-manager reachability probe (ms).
   * Defaults to 1500.
   */
  reachabilityTimeoutMs?: number;
}

export interface ApplyGeneratedHardlinkResult extends ApplyHardlinkResult {
  applied: boolean;
  entries: number;
  planPath: string;
  /**
   * `"data-manager"` when the API path succeeded, `"local"` when the host
   * `linkSync` fallback was used, `"none"` when there was nothing to do.
   */
  via: "data-manager" | "local" | "none";
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

/**
 * Quick reachability probe. The call is intentionally cheap so the failure
 * path of "data-manager isn't running yet" doesn't add seconds to every CLI
 * invocation. Treat any connection-level error as "not reachable" and let
 * the caller fall back; bubble up actual HTTP failures so a misconfigured
 * data-manager doesn't silently skip the API path.
 */
async function dataManagerReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/status`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function applyGeneratedHardlinks(
  opts: ApplyGeneratedHardlinkOptions = {},
): Promise<ApplyGeneratedHardlinkResult> {
  const paths = repoPaths(opts.rootDir);
  const planPath = join(paths.infraDir, HARDLINK_PLAN_FILENAME);
  if (!existsSync(planPath)) {
    if (opts.requirePlan) {
      throw new Error(`Hardlink plan not found at ${planPath}`);
    }
    return {
      applied: false,
      entries: 0,
      planPath,
      linked: 0,
      skipped: 0,
      pruned: 0,
      via: "none",
    };
  }

  const { plan, dataRoot } = readGeneratedHardlinkPlan(opts.rootDir);
  // Pre-create the host data root as the invoking user so docker doesn't
  // auto-create it as root on first compose up.
  mkdirSync(dataRoot, { recursive: true });

  if (!opts.forceLocal) {
    const baseUrl = opts.dataManagerUrl ?? process.env.DATA_MANAGER_URL ?? "http://localhost:4000";
    const timeout = opts.reachabilityTimeoutMs ?? 1500;
    if (await dataManagerReachable(baseUrl, timeout)) {
      const client = new DataManagerClient({ baseUrl });
      const result = await client.link(plan, { prune: opts.prune });
      return {
        applied: true,
        entries: plan.length,
        planPath,
        linked: result.linked,
        skipped: result.skipped,
        pruned: result.pruned,
        via: "data-manager",
      };
    }
  }

  const result = applyHardlinkPlan(plan, { rootDir: dataRoot, prune: opts.prune });
  return {
    applied: true,
    entries: plan.length,
    planPath,
    linked: result.linked,
    skipped: result.skipped,
    pruned: result.pruned,
    via: "local",
  };
}
