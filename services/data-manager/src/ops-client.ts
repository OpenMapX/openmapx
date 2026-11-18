import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  OPS_KIND_POLICIES,
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  parseOpsResult,
} from "@openmapx/core/ops";
import {
  isReservedAgentOperation,
  runReservedAgentOperation,
} from "./jobs/execution/agent-operations.js";
import { dataExecutionWorkerContext } from "./jobs/execution/worker-scope.js";

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
 * Submit a typed operation and return its result. A host effect runs only
 * inside a data execution that reserved it; reads run directly.
 */
export async function runOpsOperation<K extends OpsOperationKind>(
  operation: Extract<OpsOperation, { kind: K }>,
  options: { signal?: AbortSignal; operationKey?: string; pollIntervalMs?: number } = {},
): Promise<OpsResultFor<K>> {
  if (isReservedAgentOperation(operation.kind)) {
    const context = dataExecutionWorkerContext();
    if (!context) throw Error(`${operation.kind} runs only inside a data execution`);
    // The guard above narrowed the kind; the body is the one the caller typed.
    const reserved = operation as unknown as Parameters<typeof runReservedAgentOperation>[2];
    return runReservedAgentOperation(opsClient(), context, reserved, options) as Promise<
      OpsResultFor<K>
    >;
  }
  if (OPS_KIND_POLICIES[operation.kind].execution !== "sync")
    throw Error(`${operation.kind} needs a reservation in a data execution`);
  const admitted = await opsClient().execute(operation, {
    operationKey: options.operationKey ?? `opk1_${randomBytes(18).toString("base64url")}`,
    signal: options.signal,
  });
  if (admitted.execution !== "sync") throw Error("Unexpected async host effect");
  return parseOpsResult(operation.kind, admitted.value) as OpsResultFor<K>;
}
