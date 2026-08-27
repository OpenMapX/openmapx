import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
} from "@openmapx/core/ops";

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
export function resetOpsClient(): void {
  cached = undefined;
}

/**
 * A deterministic operation key derived from a durable identity, so a retry
 * after a lost response reuses the same agent-side job instead of starting a
 * second one.
 */
export function durableOpsKey(namespace: string, durableIdentity: string): string {
  const digest = createHash("sha256")
    .update("openmapx-ops-key-v1\0")
    .update(namespace)
    .update("\0")
    .update(durableIdentity)
    .digest("base64url");
  return `opk1_${digest.slice(0, 32)}`;
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
  const operationKey =
    options.operationKey ?? `opk1_${randomBytes(18).toString("base64url").slice(0, 32)}`;
  const admission = await client.execute(operation, { operationKey, signal: options.signal });
  if (admission.execution === "sync") return admission.value as OpsResultFor<K>;

  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  for (;;) {
    options.signal?.throwIfAborted();
    const status = await client.status(operation.kind, admission.operationId, {
      signal: options.signal,
    });
    if (status.state === "succeeded") return status.result as OpsResultFor<K>;
    if (status.state === "failed" || status.state === "timed_out") {
      // The agent's public error class only; no host detail crosses back.
      throw new Error(`Operation ${operation.kind} did not succeed (${status.errorClass})`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
