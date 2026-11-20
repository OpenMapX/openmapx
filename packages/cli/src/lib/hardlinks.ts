import { cliControlContext } from "./control-context";
import { assertCliExecutionAvailable, cliAcquisitionOptions } from "./execution-deadline";
import { currentHostLease } from "./host-effect";
// The CLI never links in the data directory itself: it hands the generated
// plan to data-manager's `/link` route. Other containers write into the data
// root, so a symlink planted there could race the planner's path checks;
// only data-manager's mounts confine the links and prunes to that root. The
// host CLI shares the risk, and the CLI the operations agent runs would
// reach the host checkout and the Docker socket.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createDataManagerTransport } from "@openmapx/core/data-manager-sdk";
import { createControlRootOperationKey, opsExecutionBudget } from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import {
  type ApplyHardlinkResult,
  type HardlinkEntry,
  hardlinkPlanHasWork,
} from "@openmapx/hardlinks";
import { cliDataManagerToken } from "./data-manager-token";
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

/** Data-manager or the configuration writer was taken by a configuration change or another data job. */
export class DataManagerBusyError extends Error {
  constructor(entries?: number) {
    super(
      `The hardlink plan${entries === undefined ? "" : ` (${entries} ${entries === 1 ? "entry" : "entries"})`} was not applied: data-manager is running another data job or a configuration change. Run pnpm openmapx data link once it has finished.`,
    );
    this.name = "DataManagerBusyError";
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
  try {
    // Like every other issuer, the CLI holds the configuration writer from
    // reading the plan until data-manager answered, so no configuration change
    // commits and links in between and then has its links pruned by this plan.
    return await coreServices.withConfigurationGenerationWriter(
      paths.infraDir,
      () => applyCurrentHardlinks(paths.infraDir, planPath, opts),
      cliAcquisitionOptions().signal,
    );
  } catch (error) {
    if (!(error instanceof coreServices.ConfigurationGenerationError)) throw error;
    if (error.result.outcome === "not_committed" && error.result.reason === "busy")
      throw new DataManagerBusyError();
    throw error.cause ?? error;
  }
}

/** Sends the applied generation's plan to data-manager; the caller holds the writer. */
async function applyCurrentHardlinks(
  infraDir: string,
  planPath: string,
  opts: ApplyGeneratedHardlinkOptions,
): Promise<ApplyGeneratedHardlinkResult> {
  const revisionId = coreServices.currentConfigurationGeneration(infraDir);
  if (!revisionId) throw new Error(`No applied configuration generation names ${planPath}`);
  const { plan } = control.readGenerationHardlinkPlan(infraDir, revisionId);
  const dataRoot = join(infraDir, "data");
  // Pre-create the host data root as the invoking user so docker doesn't
  // auto-create it as root on first compose up. Its mode is explicit rather
  // than the process umask's; the services that mount it run as other users.
  mkdirSync(dataRoot, { recursive: true, mode: DATA_ROOT_MODE });

  const baseUrl = opts.dataManagerUrl ?? dataManagerUrl();
  const timeout = opts.reachabilityTimeoutMs ?? 1500;
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
  const transport = createDataManagerTransport({
    ...cliAcquisitionOptions(),
    baseUrl,
    authToken: cliDataManagerToken(),
  });
  // Under a lease, the application is that operation's: data-manager admits it
  // under the lease and a repeat names the same application. Without one,
  // data-manager leases itself and the key names this call only.
  const held = currentHostLease();
  const fixed = cliControlContext();
  const issuer = held?.owner ?? fixed?.authority.execution;
  const leaseId = held?.leaseId ?? fixed?.lease?.leaseId ?? null;
  const deadlineAt =
    issuer?.deadlineAt ?? Date.now() + opsExecutionBudget("generation-link").processMs;
  let result: Awaited<ReturnType<typeof control.linkGeneration>>;
  try {
    result = await control.linkGeneration({
      transport,
      operationKey: issuer
        ? control.generationLinkOperationKey(issuer, revisionId)
        : createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      deadlineAt,
      revisionId,
      plan,
      prune: opts.prune ?? false,
      leaseId,
      signal: cliAcquisitionOptions().signal,
    });
  } catch (error) {
    if (error instanceof control.GenerationLinkNotApplied && error.reason === "busy")
      throw new DataManagerBusyError(plan.length);
    if (error instanceof control.GenerationLinkNotApplied && error.reason === "unavailable")
      throw new DataManagerUnavailableError(baseUrl, plan.length);
    if (error instanceof control.GenerationLinkUnknown)
      error.message = `Data-manager did not report whether it applied the hardlink plan (${plan.length} ${plan.length === 1 ? "entry" : "entries"}). Applying the plan again links nothing twice: run pnpm openmapx data link once data-manager answers.`;
    throw error;
  }
  return { ...result, applied: true, planPath, via: "data-manager" };
}

/**
 * Applies the plan before containers start. When data-manager is down or busy,
 * the start goes ahead without it: the links made before stay in place, and the
 * warning says how to apply the rest.
 */
export async function applyGeneratedHardlinksBeforeStart(
  opts: ApplyGeneratedHardlinkOptions = {},
): Promise<void> {
  try {
    const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true, ...opts });
    logAppliedHardlinks(linked);
  } catch (error) {
    if (!(error instanceof DataManagerUnavailableError || error instanceof DataManagerBusyError))
      throw error;
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
