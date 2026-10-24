import { randomUUID } from "node:crypto";
import type { OpsOperation, OpsResultFor } from "@openmapx/core/ops";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { installedExtension, installedIntegration } from "../db/schema";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

/**
 * Installed integrations, as the operations agent holds them.
 *
 * The agent owns `custom_integrations`: it fetches and validates integration
 * archives, swaps an integration's files in, keeps the previous copy until a
 * change is settled, records the SHA-256 of every file it installed, and
 * reports what is installed. The API decides what to install and records it;
 * nothing here writes the host filesystem.
 */

export type IntegrationSource = Extract<OpsOperation, { kind: "integration.publish" }>["source"];
export type InstalledIntegrationsSnapshot = OpsResultFor<"installedIntegrations.inspect">;
export type AgentInstalledIntegration = InstalledIntegrationsSnapshot["integrations"][number];

interface OperationOptions {
  operationKey: string;
  signal?: AbortSignal;
}

/** Fetch and validate an integration archive without installing it. */
export function inspectIntegration(
  source: IntegrationSource,
  options: OperationOptions,
): Promise<OpsResultFor<"integration.inspect">> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "integration.inspect", source },
    options.operationKey,
    { signal: options.signal },
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
): Promise<OpsResultFor<"integration.publish">> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "integration.publish", ...request },
    options.operationKey,
    { signal: options.signal },
  );
}

export async function settleIntegration(
  request: { integrationId: string; transactionId: string; outcome: "commit" | "rollback" },
  options: OperationOptions,
): Promise<OpsResultFor<"integration.settle">> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "integration.settle", ...request },
    options.operationKey,
    { signal: options.signal },
  );
  if (result.integrationId !== request.integrationId || result.outcome !== request.outcome) {
    throw new Error("The operations agent settled a different integration change");
  }
  return result;
}

export async function removeIntegration(
  request: { integrationId: string; extensionId?: string },
  options: OperationOptions,
): Promise<OpsResultFor<"integration.remove">> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "integration.remove", ...request },
    options.operationKey,
    { signal: options.signal },
  );
  if (result.integrationId !== request.integrationId) {
    throw new Error("The operations agent removed a different integration");
  }
  return result;
}

/**
 * Have the agent record an integration an earlier release installed. It is
 * recorded only when its files are exactly those of `source`, fetched again;
 * otherwise it is recorded as needing a reinstall.
 */
export async function adoptIntegration(
  request: { integrationId: string; extensionId?: string; source?: IntegrationSource },
  options: OperationOptions,
): Promise<OpsResultFor<"integration.adopt">> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "integration.adopt", ...request },
    options.operationKey,
    { signal: options.signal },
  );
  if (result.integrationId !== request.integrationId) {
    throw new Error("The operations agent adopted a different integration");
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
  adopted: string[];
  needsReinstall: Array<{ integrationId: string; reason: string | null }>;
}

const SHA256 = /^[a-f0-9]{64}$/;

/** The artifact an extension snapshot names for `integrationId`, if it names a usable one. */
function snapshotArtifact(manifest: unknown, integrationId: string): IntegrationSource | undefined {
  if (!manifest || typeof manifest !== "object") return undefined;
  const integrations = (manifest as { integrations?: unknown }).integrations;
  if (!Array.isArray(integrations)) return undefined;
  for (const entry of integrations) {
    if (!entry || typeof entry !== "object") continue;
    const { id, artifact, sha256 } = entry as Record<string, unknown>;
    if (id !== integrationId) continue;
    if (
      typeof artifact === "string" &&
      artifact.length <= 2_048 &&
      /^https:\/\/\S+$/.test(artifact) &&
      typeof sha256 === "string" &&
      SHA256.test(sha256)
    ) {
      return { kind: "artifact", url: artifact, sha256 };
    }
    return undefined;
  }
  return undefined;
}

/**
 * Settle every integration transaction an interrupted extension change left
 * pending, then have the agent adopt integrations earlier releases installed.
 *
 * The extension's database transaction is the commit point: it records the
 * agent transaction on the integration's row. A pending transaction the row
 * records is committed; every other one is rolled back.
 *
 * Adoption covers every `installed_integration` row the agent holds no record
 * of. The agent verifies the files on disk against the artifact the owning
 * extension's snapshot names; one it cannot verify is recorded as needing a
 * reinstall, which is reported and never fails recovery. Must not run while an
 * extension change is in progress.
 */
export async function recoverAgentIntegrations(
  options: {
    signal?: AbortSignal;
    log?: IntegrationRecoveryLog;
    /**
     * Also adopt what the agent holds no record of. Adoption downloads each
     * extension's archive again, so startup leaves it to a background pass.
     */
    adopt?: boolean;
  } = {},
): Promise<IntegrationRecoveryOutcome> {
  const log = options.log ?? {
    info: (message: string) => console.info(`[extension-recovery] ${message}`),
    warn: (message: string) => console.warn(`[extension-recovery] ${message}`),
  };
  const outcome: IntegrationRecoveryOutcome = {
    committed: [],
    rolledBack: [],
    adopted: [],
    needsReinstall: [],
  };

  let snapshot = await readInstalledIntegrations({ signal: options.signal });
  for (const entry of snapshot.integrations) {
    if (!entry.pending) continue;
    const { transactionId } = entry.pending;
    const [row] = await db
      .select({ lastTransactionId: installedIntegration.lastTransactionId })
      .from(installedIntegration)
      .where(eq(installedIntegration.id, entry.integrationId))
      .limit(1);
    const settleOutcome = row?.lastTransactionId === transactionId ? "commit" : "rollback";
    await settleIntegration(
      { integrationId: entry.integrationId, transactionId, outcome: settleOutcome },
      {
        operationKey: createDurableOpsKey(
          `extension.integration.recovery.${settleOutcome}`,
          `${entry.integrationId}:${transactionId}`,
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
  // A rollback of a fresh install drops its record; adopt from what is left.
  if (outcome.rolledBack.length > 0) {
    snapshot = await readInstalledIntegrations({ signal: options.signal });
  }

  if (options.adopt === false) return outcome;
  const recorded = new Set(snapshot.integrations.map((entry) => entry.integrationId));
  const rows = await db
    .select({
      id: installedIntegration.id,
      managedByExtension: installedIntegration.managedByExtension,
    })
    .from(installedIntegration);
  const candidates = rows.filter((row) => !recorded.has(row.id));
  const rowIds = new Set(rows.map((row) => row.id));
  for (const integrationId of snapshot.unrecorded) {
    if (rowIds.has(integrationId)) continue;
    log.warn(
      `custom_integrations/${integrationId} is not recorded by the operations agent or by any installed extension; it is not loaded until it is reinstalled`,
    );
  }
  if (candidates.length === 0) return outcome;

  const extensionIds = [
    ...new Set(
      candidates.flatMap((row) => (row.managedByExtension ? [row.managedByExtension] : [])),
    ),
  ];
  const snapshots = new Map<string, unknown>();
  if (extensionIds.length > 0) {
    const extensions = await db
      .select({ id: installedExtension.id, manifest: installedExtension.manifest })
      .from(installedExtension)
      .where(inArray(installedExtension.id, extensionIds));
    for (const extension of extensions) snapshots.set(extension.id, extension.manifest);
  }

  for (const row of candidates) {
    const source = row.managedByExtension
      ? snapshotArtifact(snapshots.get(row.managedByExtension), row.id)
      : undefined;
    try {
      const adopted = await adoptIntegration(
        {
          integrationId: row.id,
          ...(row.managedByExtension ? { extensionId: row.managedByExtension } : {}),
          ...(source ? { source } : {}),
        },
        {
          // Adoption that could not download the archive is not persisted and
          // is retried by the next recovery, so every attempt is its own.
          operationKey: createDurableOpsKey(
            "extension.integration.adopt",
            `${row.id}:${randomUUID()}`,
          ),
          signal: options.signal,
        },
      );
      if (adopted.status === "recorded") {
        outcome.adopted.push(row.id);
        log.info(`The operations agent adopted integration "${row.id}"`);
      } else {
        outcome.needsReinstall.push({ integrationId: row.id, reason: adopted.reason });
        log.warn(
          `Integration "${row.id}" needs to be reinstalled and is not loaded: ${adopted.reason ?? "its files could not be verified"}`,
        );
      }
    } catch (error) {
      log.warn(
        `The operations agent could not adopt integration "${row.id}" yet: ${(error as Error).message}`,
      );
    }
  }
  return outcome;
}
