import { createHash, randomUUID } from "node:crypto";
import type { OpsResultFor } from "@openmapx/core/ops";
import { assertAllowedGitUrl, services as coreServices } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { serviceRepository } from "../db/schema";
import { createApiOpsClient, createDurableOpsKey, executeAndWait } from "./ops-client";

/**
 * Community service repositories, as the operations agent holds them.
 *
 * The agent owns the checkouts in its community store: it
 * fetches and validates repositories, swaps checkouts in, keeps the previous
 * checkout until a change is settled, and reports what is installed. The API
 * decides what to install and records it; nothing here touches the host
 * filesystem.
 */

/** Directory name of a repository's checkout: the first 16 hex digits of the SHA-256 of its canonical URL. */
export function hashUrl(canonicalUrl: string): string {
  return createHash("sha256").update(canonicalUrl).digest("hex").slice(0, 16);
}

/** What the API needs to undo an interrupted extension change; the agent keeps it with the transaction. */
export interface RepositoryRecovery {
  selectionBefore: string[] | null;
  touchedServiceIds: string[];
  previouslyEnabledServiceIds: string[];
}

export interface InspectedRepositoryService {
  manifest: coreServices.ServiceManifest;
  /** Directory holding the manifest, relative to the repository root. */
  path: string;
}

export interface RepositoryInspection {
  url: string;
  repository: string;
  commit: string;
  valid: boolean;
  problems: string[];
  services: InspectedRepositoryService[];
}

export interface CommunityServicesSnapshot {
  revisionId: string;
  repositories: OpsResultFor<"communityServices.inspect">["repositories"];
  services: Array<{
    repository: string;
    directory: string;
    manifest: coreServices.ServiceManifest;
  }>;
  /** Reported services the API's own manifest rules reject. */
  problems: string[];
  /** Ids of every service the agent reported, including rejected ones. */
  reportedServiceIds: string[];
}

interface OperationOptions {
  operationKey: string;
  signal?: AbortSignal;
}

/** Fetch and validate a repository at `ref` without installing it. */
export async function inspectServiceRepository(
  url: string,
  ref: string | undefined,
  options: OperationOptions,
): Promise<RepositoryInspection> {
  const { canonical } = assertAllowedGitUrl(url);
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "serviceRepository.inspect", url: canonical, ...(ref ? { ref } : {}) },
    options.operationKey,
    { signal: options.signal },
  );
  if (result.url !== canonical || result.repository !== hashUrl(canonical)) {
    throw new Error("The operations agent inspected a different repository");
  }
  const problems = [...result.problems];
  const services: InspectedRepositoryService[] = [];
  for (const entry of result.services) {
    const label = entry.path ? `${entry.path}/service.json` : "service.json";
    const manifestProblems = coreServices.communityServiceManifestProblems(entry.manifest);
    if (manifestProblems.length > 0) {
      for (const problem of manifestProblems) problems.push(`${label}: ${problem}`);
      continue;
    }
    services.push({
      manifest: entry.manifest as unknown as coreServices.ServiceManifest,
      path: entry.path,
    });
  }
  return {
    url: canonical,
    repository: result.repository,
    commit: result.commit,
    valid: result.valid && problems.length === result.problems.length,
    problems,
    services,
  };
}

/** Install an exact commit; the agent keeps the previous checkout until the change is settled. */
export async function publishServiceRepository(
  request: {
    url: string;
    commit: string;
    ref?: string;
    extensionId: string;
    recovery: RepositoryRecovery;
  },
  options: OperationOptions,
): Promise<OpsResultFor<"serviceRepository.publish">> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "serviceRepository.publish", ...request },
    options.operationKey,
    { signal: options.signal },
  );
  if (result.repository !== hashUrl(request.url) || result.commit !== request.commit) {
    throw new Error("The operations agent installed a different repository");
  }
  return result;
}

export function settleServiceRepository(
  request: {
    repository: string;
    transactionId: string;
    outcome: "commit" | "rollback" | "release";
  },
  options: OperationOptions,
): Promise<OpsResultFor<"serviceRepository.settle">> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "serviceRepository.settle", ...request },
    options.operationKey,
    { signal: options.signal },
  );
}

export function removeServiceRepository(
  request: { repository: string; extensionId: string },
  options: OperationOptions,
): Promise<OpsResultFor<"serviceRepository.remove">> {
  return executeAndWait(
    createApiOpsClient(),
    { kind: "serviceRepository.remove", ...request },
    options.operationKey,
    { signal: options.signal },
  );
}

/** Installed community services and repositories, validated again with the community manifest rules. */
export async function readCommunityServices(
  options: { signal?: AbortSignal } = {},
): Promise<CommunityServicesSnapshot> {
  const result = await executeAndWait(
    createApiOpsClient(),
    { kind: "communityServices.inspect" },
    createDurableOpsKey("community.services.inspect", randomUUID()),
    { signal: options.signal },
  );
  const problems: string[] = [];
  const services: CommunityServicesSnapshot["services"] = [];
  for (const entry of result.services) {
    const manifestProblems = coreServices.communityServiceManifestProblems(entry.manifest);
    if (manifestProblems.length > 0) {
      problems.push(
        `Community service in repository ${entry.repository} was rejected: ${manifestProblems.join("; ")}`,
      );
      continue;
    }
    services.push({
      repository: entry.repository,
      directory: entry.directory,
      manifest: entry.manifest as unknown as coreServices.ServiceManifest,
    });
  }
  return {
    revisionId: result.revisionId,
    repositories: result.repositories,
    services,
    problems,
    reportedServiceIds: result.services.flatMap((entry) =>
      typeof entry.manifest.id === "string" ? [entry.manifest.id] : [],
    ),
  };
}

export interface ServiceRuntimeRecovery {
  runtimeRecoveryNeeded: boolean;
  orphanedServiceIds: string[];
  restartServiceIds: string[];
  incidentId?: string;
}

/**
 * Settle every repository transaction an interrupted extension change left
 * pending. The extension's database transaction is the commit point: it
 * records the agent transaction it installed. A published transaction the
 * database records is committed. Every other one is rolled back: first the
 * service runtimes to repair are recorded, then each previous checkout is
 * restored, then the selection from before the change is applied once those
 * checkouts are back, and only then does the agent drop its recovery notes.
 * Each step is safe to repeat, so a failure at any point is retried by the
 * next recovery. Must not run while an extension change is in progress.
 */
export async function reconcileCommunityRepositoryTransactions(
  options: {
    restoreSelection?: (roots: string[], recoveryId: string) => Promise<void>;
    persistRuntimeRecovery?: (recovery: ServiceRuntimeRecovery) => Promise<void>;
    signal?: AbortSignal;
  } = {},
): Promise<ServiceRuntimeRecovery> {
  const snapshot = await readCommunityServices({ signal: options.signal });
  const pending = snapshot.repositories.flatMap((repository) =>
    repository.pending ? [{ repository: repository.repository, pending: repository.pending }] : [],
  );
  if (pending.length === 0) {
    return { runtimeRecoveryNeeded: false, orphanedServiceIds: [], restartServiceIds: [] };
  }
  const incidentId = `recovery_${createHash("sha256")
    .update(
      pending
        .map(({ repository, pending: transaction }) => `${repository}:${transaction.transactionId}`)
        .sort()
        .join("\n"),
    )
    .digest("hex")}`;
  const settle = (
    repository: string,
    transactionId: string,
    outcome: "commit" | "rollback" | "release",
  ) =>
    settleServiceRepository(
      { repository, transactionId, outcome },
      {
        operationKey: createDurableOpsKey(
          `community.repository.${outcome}`,
          `${incidentId}:${repository}:${transactionId}`,
        ),
        signal: options.signal,
      },
    );

  const undone: typeof pending = [];
  for (const entry of pending) {
    if (entry.pending.phase === "published") {
      const [row] = await db
        .select({ lastTransactionId: serviceRepository.lastTransactionId })
        .from(serviceRepository)
        .where(eq(serviceRepository.hash, entry.repository))
        .limit(1);
      if (row?.lastTransactionId === entry.pending.transactionId) {
        await settle(entry.repository, entry.pending.transactionId, "commit");
        continue;
      }
    }
    undone.push(entry);
  }
  if (undone.length === 0) {
    return { runtimeRecoveryNeeded: false, orphanedServiceIds: [], restartServiceIds: [] };
  }

  const orphanedServiceIds = new Set<string>();
  const restartServiceIds = new Set<string>();
  for (const { pending: transaction } of undone) {
    for (const id of transaction.recovery.touchedServiceIds) orphanedServiceIds.add(id);
    for (const id of transaction.recovery.previouslyEnabledServiceIds) restartServiceIds.add(id);
  }
  const recovery: ServiceRuntimeRecovery = {
    runtimeRecoveryNeeded: orphanedServiceIds.size > 0 || restartServiceIds.size > 0,
    orphanedServiceIds: [...orphanedServiceIds].sort(),
    restartServiceIds: [...restartServiceIds].sort(),
    incidentId,
  };
  if (recovery.runtimeRecoveryNeeded) await options.persistRuntimeRecovery?.(recovery);
  // Newest changes were published last; undo them first.
  for (const { repository, pending: transaction } of [...undone].reverse()) {
    if (transaction.phase === "published") {
      await settle(repository, transaction.transactionId, "rollback");
    }
  }
  // Every pending transaction belongs to the one interrupted change, so they
  // share the selection from before it.
  const selectionBefore = undone.find(
    ({ pending: transaction }) => transaction.recovery.selectionBefore !== null,
  )?.pending.recovery.selectionBefore;
  if (selectionBefore) await options.restoreSelection?.(selectionBefore, incidentId);
  for (const { repository, pending: transaction } of undone) {
    await settle(repository, transaction.transactionId, "release");
  }
  return recovery.runtimeRecoveryNeeded
    ? recovery
    : { runtimeRecoveryNeeded: false, orphanedServiceIds: [], restartServiceIds: [] };
}
