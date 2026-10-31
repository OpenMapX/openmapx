import {
  assertCliExecutionAvailable,
  assertCliRemoteMutationSupported,
  cliAcquisitionOptions,
} from "./execution-deadline";
// The CLI never links in the data directory itself: it hands the generated
// plan to data-manager's `/link` route. Other containers write into the data
// root, so a symlink planted there could race the planner's path checks;
// only data-manager's mounts confine the links and prunes to that root. The
// host CLI shares the risk, and the CLI the operations agent runs would
// reach the host checkout and the Docker socket.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDataManagerTransport,
  link,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import { services as coreServices } from "@openmapx/core/server";
import {
  type ApplyHardlinkResult,
  type HardlinkEntry,
  hardlinkPlanHasWork,
} from "@openmapx/hardlinks";
import { dataManagerUrl } from "./data-manager-url";
import { log } from "./output";
import { repoPaths } from "./paths";

/** The data root's mode when the CLI creates it: the owner writes, everyone traverses. */
export const DATA_ROOT_MODE = 0o755;
export type { ApplyHardlinkResult, HardlinkEntry };

/** The plan has links to make or prune and data-manager, which applies them, is not reachable. */
export class DataManagerUnavailableError extends Error {
  constructor(baseUrl: string, entries: number) {
    super(
      `The hardlink plan (${entries} ${entries === 1 ? "entry" : "entries"}) was not applied: data-manager applies it inside its container, whose mounts confine every link to the data directory, and it is not reachable at ${baseUrl}. Start data-manager (pnpm openmapx services start data-manager), then run pnpm openmapx data link.`,
    );
    this.name = "DataManagerUnavailableError";
  }
}

export interface ApplyGeneratedHardlinkOptions {
  rootDir?: string;
  prune?: boolean;
  /**
   * When true, throws if the generated hardlink plan file is missing.
   * Otherwise, returns `applied: false`.
   */
  requirePlan?: boolean;
  /**
   * Override the data-manager URL. Defaults to {@link dataManagerUrl}.
   */
  dataManagerUrl?: string;
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
   * `"data-manager"` when data-manager applied the plan, `"none"` when there
   * was nothing to do.
   */
  via: "data-manager" | "none";
}

function hardlinkPlanPath(infraDir: string): string {
  return coreServices.currentConfigurationFile(infraDir, coreServices.GENERATED_HARDLINK_PLAN_FILE);
}

export function readGeneratedHardlinkPlan(rootDir?: string): {
  plan: HardlinkEntry[];
  planPath: string;
  dataRoot: string;
} {
  const paths = repoPaths(rootDir);
  const planPath = hardlinkPlanPath(paths.infraDir);
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
 * invocation. Any connection-level error or failed status reads as "not
 * reachable".
 */
async function dataManagerReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/status`, {
      signal: cliAcquisitionOptions().signal
        ? AbortSignal.any([controller.signal, cliAcquisitionOptions().signal!])
        : controller.signal,
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
  assertCliExecutionAvailable();
  const paths = repoPaths(opts.rootDir);
  const planPath = hardlinkPlanPath(paths.infraDir);
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
  // auto-create it as root on first compose up. Its mode is explicit rather
  // than the process umask's; the services that mount it run as other users.
  mkdirSync(dataRoot, { recursive: true, mode: DATA_ROOT_MODE });

  const baseUrl = opts.dataManagerUrl ?? dataManagerUrl();
  const timeout = opts.reachabilityTimeoutMs ?? 1500;
  if (!(await dataManagerReachable(baseUrl, timeout))) {
    // Before any data exists, typically the first `compose up`, there is
    // nothing to link or prune.
    if (!hardlinkPlanHasWork(plan, { rootDir: dataRoot })) {
      return {
        applied: false,
        entries: plan.length,
        planPath,
        linked: 0,
        skipped: 0,
        pruned: 0,
        via: "none",
      };
    }
    throw new DataManagerUnavailableError(baseUrl, plan.length);
  }
  assertCliExecutionAvailable();
  assertCliRemoteMutationSupported();
  const transport = createDataManagerTransport({
    ...cliAcquisitionOptions(),
    baseUrl,
    authToken: process.env.DATA_MANAGER_AUTH_TOKEN?.trim(),
  });
  const result = unwrapDataManagerResponse(await link({ plan, prune: opts.prune }, { transport }));
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

/**
 * Applies the plan before containers start. When data-manager is down, the
 * start goes ahead without it: the links made before stay in place, and the
 * warning says how to apply the rest once data-manager runs.
 */
export async function applyGeneratedHardlinksBeforeStart(
  opts: ApplyGeneratedHardlinkOptions = {},
): Promise<void> {
  try {
    const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true, ...opts });
    logAppliedHardlinks(linked);
  } catch (error) {
    if (!(error instanceof DataManagerUnavailableError)) throw error;
    log.warn(error.message);
  }
}

export function logAppliedHardlinks(linked: ApplyGeneratedHardlinkResult): void {
  if (!linked.applied) {
    log.dim("No hardlinks to apply yet: no data has been produced.");
    return;
  }
  log.ok(
    `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
  );
}
