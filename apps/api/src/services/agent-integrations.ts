import { randomUUID } from "node:crypto";
import type { OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { installedExtension, installedIntegration } from "../db/schema";
import { JobObservationPending } from "./admin-job-failure";
import { executeAdminJobOperation } from "./admin-job-ops";
import { readProjection } from "./admin-job-projection";
import type { JobContext } from "./job-runner";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

/**
 * Installed integrations, as the operations agent holds them.
 *
 * The agent owns the integration store, which app-api mounts read-only at
 * `custom_integrations`: it fetches and validates integration
 * archives, swaps an integration's files in, keeps the previous copy until a
 * change is settled, records the SHA-256 of every file it installed, and
 * reports what is installed. The API decides what to install and records it;
 * nothing here writes the host filesystem.
 */

export type IntegrationSource = Extract<
  OpsOperation,
  { kind: "catalogIntegration.publish" }
>["source"];
export type InstalledIntegrationsSnapshot = OpsResultFor<"installedIntegrations.inspect">;
export type AgentInstalledIntegration = InstalledIntegrationsSnapshot["integrations"][number];

interface OperationOptions {
  ctx: JobContext;
  operationKey: string;
  signal?: AbortSignal;
}

/** Fetch and validate an integration archive without installing it. */
export function inspectIntegration(
  source: IntegrationSource,
  options: OperationOptions,
): Promise<OpsResultFor<"catalogIntegration.inspect">> {
  return executeAdminJobOperation(
    options.ctx,
    { kind: "catalogIntegration.inspect", source },
    "extension.catalog.inspect",
    { operationKey: options.operationKey },
  );
}

/**
 * Install an integration archive; the agent keeps the previous copy until the
 * transaction is settled. The result is returned as the agent gave it: the
 * caller records the transaction before it checks the reported id, so a
 * mismatching answer can still be rolled back.
 */
export function publishIntegration(
  request: { integrationId: string; source: IntegrationSource; extensionId?: string },
  options: OperationOptions,
): Promise<OpsResultFor<"catalogIntegration.publish">> {
  return executeAdminJobOperation(
    options.ctx,
    { kind: "catalogIntegration.publish", ...request },
    "extension.catalog.publish",
    { operationKey: options.operationKey },
  );
}

export async function settleIntegration(
  request: { integrationId: string; transactionId: string; outcome: "commit" | "rollback" },
  options: OperationOptions,
): Promise<OpsResultFor<"catalogIntegration.settle">> {
  const result = await executeAdminJobOperation(
    options.ctx,
    { kind: "catalogIntegration.settle", ...request },
    "extension.catalog.settle",
    { operationKey: options.operationKey },
  );
  if (result.integrationId !== request.integrationId || result.outcome !== request.outcome) {
    throw new Error("The operations agent settled a different integration change");
  }
  return result;
}

export async function removeIntegration(
  request: { integrationId: string; extensionId?: string },
  options: OperationOptions,
): Promise<OpsResultFor<"catalogIntegration.remove">> {
  const result = await executeAdminJobOperation(
    options.ctx,
    { kind: "catalogIntegration.remove", ...request },
    "extension.catalog.remove",
    { operationKey: options.operationKey },
  );
  if (result.integrationId !== request.integrationId) {
    throw new Error("The operations agent removed a different integration");
  }
  return result;
}

/** Every integration the agent records, with its file digests, and the directories it does not. */
export function readInstalledIntegrations(
  options: { signal?: AbortSignal } = {},
): Promise<InstalledIntegrationsSnapshot> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "installedIntegrations.inspect" },
    createDurableOpsKey("integrations.installed.inspect", randomUUID()),
    { signal: options.signal },
  );
}

// ---------------------------------------------------------------------------
// What the integration host loads
// ---------------------------------------------------------------------------

/** An installed integration the agent reports intact, with the digest of every file it installed. */
export interface LoadableIntegration {
  integrationId: string;
  files: Array<{ path: string; sha256: string }>;
}

const LOADABLE_READ_TIMEOUT_MS = 15_000;
const LOADABLE_RETRY_MS = 60_000;

/** The last loadable integrations the agent reported. */
let lastLoadable: LoadableIntegration[] | null = null;
/** What the integration host was last given, to tell whether a retry changed anything. */
let servedFingerprint: string | null = null;
let loadableRetry: NodeJS.Timeout | null = null;

function fingerprint(loadable: readonly LoadableIntegration[]): string {
  return JSON.stringify(loadable);
}

async function fetchLoadableIntegrations(): Promise<LoadableIntegration[]> {
  const snapshot = await readInstalledIntegrations({
    signal: AbortSignal.timeout(LOADABLE_READ_TIMEOUT_MS),
  });
  const loadable: LoadableIntegration[] = [];
  for (const entry of snapshot.integrations) {
    if (entry.status !== "ok") {
      console.warn(
        `[integrations] Installed integration "${entry.integrationId}" is not loaded: ${entry.reason ?? "it needs to be reinstalled"}`,
      );
      continue;
    }
    loadable.push({ integrationId: entry.integrationId, files: entry.files });
  }
  for (const integrationId of snapshot.unrecorded) {
    console.warn(
      `[integrations] custom_integrations/${integrationId} is not loaded: the operations agent did not install it`,
    );
  }
  loadable.sort((left, right) => (left.integrationId < right.integrationId ? -1 : 1));
  lastLoadable = loadable;
  return loadable;
}

function scheduleLoadableRetry(onChange?: () => void): void {
  if (loadableRetry) return;
  loadableRetry = setTimeout(() => {
    loadableRetry = null;
    fetchLoadableIntegrations().then(
      (loadable) => {
        if (fingerprint(loadable) !== servedFingerprint) onChange?.();
      },
      () => scheduleLoadableRetry(onChange),
    );
  }, LOADABLE_RETRY_MS);
  loadableRetry.unref();
}

/**
 * The installed integrations the integration host may load: those the agent
 * reports intact. While the agent is unreachable the last reported list stays
 * in use and a retry is scheduled; `onChange` runs when a retry finds a
 * different list. An API run on the host without an agent configured
 * (development) returns null and scans the directory instead.
 */
export async function readLoadableIntegrations(
  options: { onChange?: () => void } = {},
): Promise<LoadableIntegration[] | null> {
  if (!process.env.OPS_AGENT_URL?.trim()) return null;
  try {
    await fetchLoadableIntegrations();
  } catch (error) {
    console.warn(
      lastLoadable
        ? `[integrations] The operations agent is unreachable; installed integrations are loaded as last reported: ${(error as Error).message}`
        : `[integrations] The operations agent is unreachable; installed integrations are not loaded yet: ${(error as Error).message}`,
    );
    scheduleLoadableRetry(options.onChange);
  }
  const served = lastLoadable ?? [];
  servedFingerprint = fingerprint(served);
  return served;
}

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export interface IntegrationRecoveryLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface IntegrationRecoveryOutcome {
  committed: string[];
  rolledBack: string[];
}

/**
 * Settle every integration transaction an interrupted extension change left
 * pending, then report installed integrations the agent holds no record of.
 *
 * The extension's database transaction is the commit point: it records the
 * agent transaction on the integration's row. A pending transaction the row
 * records is committed; every other one is rolled back.
 *
 * With a job, an `installed_integration` row the agent does not record is
 * reported, and so is a directory in its store that no row names; neither is
 * loaded until it is reinstalled. A standalone installation is managed outside
 * the agent's store, so its row is never reported. Must not run while an
 * extension change is in progress.
 */
export async function recoverAgentIntegrations(
  options: {
    signal?: AbortSignal;
    log?: IntegrationRecoveryLog;
    /** The running job. Settling needs one to own its operations; without it recovery only observes. */
    ctx?: JobContext;
  } = {},
): Promise<IntegrationRecoveryOutcome> {
  const log = options.log ?? {
    info: (message: string) => console.info(`[extension-recovery] ${message}`),
    warn: (message: string) => console.warn(`[extension-recovery] ${message}`),
  };
  const outcome: IntegrationRecoveryOutcome = { committed: [], rolledBack: [] };

  let snapshot = await readInstalledIntegrations({ signal: options.signal });
  for (const entry of snapshot.integrations) {
    if (!entry.pending) continue;
    if (!options.ctx) {
      log.warn(
        `Integration "${entry.integrationId}" has a retained transaction requiring its original administrative job; startup observation cannot settle it`,
      );
      continue;
    }
    const { transactionId } = entry.pending;
    const projection = readProjection(options.ctx.checkpointResult);
    const original = Object.values(projection.operations).find(
      (operation) =>
        operation.kind === "catalogIntegration.publish" &&
        operation.attempt?.apiJobId === options.ctx!.jobId &&
        operation.operation?.kind === "catalogIntegration.publish" &&
        operation.operation.integrationId === entry.integrationId,
    );
    if (!original?.operation || original.operation.kind !== "catalogIntegration.publish") {
      log.warn(
        `Integration "${entry.integrationId}" requires recovery by its original administrative job; its transaction cannot be settled by this job`,
      );
      throw new JobObservationPending("recovery_required");
    }
    const step = Object.entries(projection.steps).find(
      ([, value]) => value.operationKey === original.operationKey,
    )?.[0];
    if (!step) throw new JobObservationPending("recovery_required");
    const publication = await executeAdminJobOperation(
      options.ctx,
      original.operation,
      "extension.catalog.publish",
      { operationKey: step },
    );
    if (publication.transactionId !== transactionId)
      throw new JobObservationPending("recovery_required");
    const [row] = await db
      .select({ lastTransactionId: installedIntegration.lastTransactionId })
      .from(installedIntegration)
      .where(eq(installedIntegration.id, entry.integrationId))
      .limit(1);
    const settleOutcome = row?.lastTransactionId === transactionId ? "commit" : "rollback";
    await settleIntegration(
      { integrationId: entry.integrationId, transactionId, outcome: settleOutcome },
      {
        ctx: options.ctx,
        operationKey: createDurableOpsKey(
          `extension.integration.${settleOutcome}`,
          `${options.ctx.jobId}:${entry.integrationId}:${transactionId}`,
        ),
        signal: options.signal,
      },
    );
    if (settleOutcome === "commit") {
      outcome.committed.push(entry.integrationId);
      log.info(`Committed the interrupted install of integration "${entry.integrationId}"`);
    } else {
      outcome.rolledBack.push(entry.integrationId);
      log.warn(`Rolled back the interrupted install of integration "${entry.integrationId}"`);
    }
  }
  // A rollback of a fresh install drops its record; report from what is left.
  if (outcome.rolledBack.length > 0) {
    snapshot = await readInstalledIntegrations({ signal: options.signal });
  }

  if (!options.ctx) return outcome;
  const recorded = new Set(snapshot.integrations.map((entry) => entry.integrationId));
  const rows = await db
    .select({
      id: installedIntegration.id,
      installationKind: installedExtension.installationKind,
    })
    .from(installedIntegration)
    .leftJoin(
      installedExtension,
      eq(installedExtension.id, installedIntegration.managedByExtension),
    );
  for (const row of rows) {
    if (recorded.has(row.id) || row.installationKind === "standalone") continue;
    log.warn(
      `Integration "${row.id}" is not recorded by the operations agent; it is not loaded until it is reinstalled`,
    );
  }
  const rowIds = new Set(rows.map((row) => row.id));
  for (const integrationId of snapshot.unrecorded) {
    if (rowIds.has(integrationId)) continue;
    log.warn(
      `custom_integrations/${integrationId} is not recorded by the operations agent or by any installed extension; it is not loaded until it is reinstalled`,
    );
  }
  return outcome;
}
