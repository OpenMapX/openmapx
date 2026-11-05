import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { setTimeout as waitForOpsStatus } from "node:timers/promises";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  OPS_KIND_POLICIES,
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  opsOperationFingerprint,
  parseControlRootOperationKey,
  parseOpsResult,
} from "@openmapx/core/ops";
import {
  checkpointLegacyDataOperation,
  legacyDataMutation,
} from "./jobs/execution/legacy-mutation.js";

/**
 * Data-manager's client for the private operations agent.
 *
 * Data-manager holds no Docker socket. Every host effect it needs — restarting
 * a MOTIS container, reloading the feed proxy, inspecting PostgreSQL capacity —
 * is requested as a typed operation authenticated with data-manager's own
 * bearer token, so a compromise of this service cannot reach the host.
 */
let cached: OpsClient | undefined;

export function createDataManagerOpsClient(env: NodeJS.ProcessEnv = process.env): OpsClient {
  const baseUrl = env.OPS_AGENT_URL?.trim();
  const tokenFile = env.OPS_AGENT_TOKEN_FILE?.trim();
  if (!baseUrl || !tokenFile || !isAbsolute(tokenFile)) {
    throw new Error("Ops agent configuration is unavailable");
  }
  try {
    return new OpsClient({ baseUrl, tokenFile });
  } catch {
    throw new Error("Ops agent configuration is unavailable");
  }
}

export function opsClient(): OpsClient {
  cached ??= createDataManagerOpsClient();
  return cached;
}

/** Test seam: drop the memoized client so a new environment is picked up. */
export function resetOpsClient(client?: OpsClient): void {
  cached = client;
}

/**
 * Submit a typed operation and wait for its result. Synchronous kinds return
 * directly; asynchronous kinds are polled to a terminal state.
 */
export async function runOpsOperation<K extends OpsOperationKind>(
  operation: Extract<OpsOperation, { kind: K }>,
  options: { signal?: AbortSignal; operationKey?: string; pollIntervalMs?: number } = {},
): Promise<OpsResultFor<K>> {
  const client = opsClient();
  if (OPS_KIND_POLICIES[operation.kind].execution === "sync") {
    if (operation.kind === "transitousLock.propose") {
      if (!legacyDataMutation())
        throw Error("A retained data mutation owner is required for a proposal");
      const admittedAt = Date.now(),
        requestedDeadlineAt = options.operationKey
          ? parseControlRootOperationKey(options.operationKey).notAfter
          : admittedAt + OPS_KIND_POLICIES[operation.kind].timeoutMs,
        operationKey =
          options.operationKey ??
          createControlRootOperationKey({ notAfter: requestedDeadlineAt, nonce: randomBytes(16) }),
        operationFingerprint = opsOperationFingerprint(operation),
        normalized = normalizeExecutionAdmission({
          kind: operation.kind,
          operationKey,
          operationFingerprint,
          admittedAt,
          requestedDeadlineAt,
        }),
        retained = {
          operationKey,
          operation,
          operationFingerprint,
          ...normalized,
          state: "attempted",
        };
      await checkpointLegacyDataOperation(retained);
      const accepted = await client.execute(operation, {
        operationKey,
        execution: { requestedDeadlineAt },
        signal: options.signal,
      });
      if (accepted.execution !== "sync") throw Error("Unexpected asynchronous proposal");
      const result = parseOpsResult(operation.kind, accepted.value);
      await checkpointLegacyDataOperation({ ...retained, state: "terminal", result });
      return result as OpsResultFor<K>;
    }
    const admitted = await client.execute(operation, {
      operationKey: options.operationKey ?? `opk1_${randomBytes(18).toString("base64url")}`,
      signal: options.signal,
    });
    if (admitted.execution !== "sync") throw Error("Unexpected async host effect");
    return parseOpsResult(operation.kind, admitted.value) as OpsResultFor<K>;
  }
  if (!legacyDataMutation())
    throw Error("A retained data mutation must own asynchronous host effects");
  const admittedAt = Date.now(),
    requestedDeadlineAt = admittedAt + OPS_KIND_POLICIES[operation.kind].timeoutMs,
    operationKey =
      options.operationKey ??
      createControlRootOperationKey({ notAfter: requestedDeadlineAt, nonce: randomBytes(16) });
  const normalized = normalizeExecutionAdmission({
    kind: operation.kind,
    operationKey,
    operationFingerprint: opsOperationFingerprint(operation),
    admittedAt,
    requestedDeadlineAt,
  });
  let retained = {
    operationKey,
    operation,
    operationFingerprint: opsOperationFingerprint(operation),
    fingerprint: normalized.fingerprint,
    admittedAt,
    deadlineAt: normalized.deadlineAt,
    state: "attempted",
    operationId: undefined as string | undefined,
    cancellationRequestedAt: null as string | null,
  };
  await checkpointLegacyDataOperation(retained);
  try {
    const admitted = await client.execute(operation, {
      operationKey,
      execution: { requestedDeadlineAt },
      signal: options.signal,
    });
    if (admitted.execution !== "async") throw Error("Unexpected synchronous host effect");
    retained = { ...retained, operationId: admitted.operationId, state: "observing" };
    await checkpointLegacyDataOperation(retained);
  } catch {
    /* One POST only. Resolve ambiguous admission through the exact retained key. */
  }
  const settlement = AbortSignal.timeout(30000);
  for (;;) {
    if (options.signal?.aborted && retained.cancellationRequestedAt === null) {
      retained = { ...retained, cancellationRequestedAt: new Date().toISOString() };
      await checkpointLegacyDataOperation(retained);
    }
    const signal = options.signal?.aborted ? settlement : options.signal;
    const status = await client.lookup(operation, operationKey, {
      fingerprint: normalized.fingerprint,
      execution: { requestedDeadlineAt },
      signal,
    });
    if (
      status.version !== 2 ||
      status.operationKey !== operationKey ||
      status.kind !== operation.kind ||
      status.fingerprint !== normalized.fingerprint ||
      status.deadlineAt !== normalized.deadlineAt ||
      (retained.operationId && status.operationId !== retained.operationId)
    )
      throw Error("Retained host effect identity conflict");
    if (!retained.operationId) {
      retained = { ...retained, operationId: status.operationId, state: "observing" };
      await checkpointLegacyDataOperation(retained);
    }
    if (["succeeded", "failed", "timed_out"].includes(status.state)) {
      await checkpointLegacyDataOperation({ ...retained, state: "terminal", status });
      if (status.state === "succeeded")
        return parseOpsResult(operation.kind, status.result) as OpsResultFor<K>;
      throw Error(`Operation ${operation.kind} did not succeed (${status.errorClass})`);
    }
    if (options.signal?.aborted)
      try {
        await client.cancel(status.operationId, {
          fingerprint: normalized.fingerprint,
          signal: settlement,
        });
      } catch {
        /* Lost cancel response is observation-only. */
      }
    await waitForOpsStatus(options.pollIntervalMs ?? 1000, undefined, { signal });
  }
}
