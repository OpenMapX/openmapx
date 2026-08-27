import type { TrustedConfigurationPayload } from "@openmapx/core/ops";
import {
  OPS_OPERATION_KINDS,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  parseOpsResult,
} from "@openmapx/core/ops";

export class OpsNotWiredError extends Error {
  constructor() {
    super("Typed adapter is not wired");
    this.name = "OpsNotWiredError";
  }
}

export interface OpsExecutionContext {
  signal: AbortSignal;
  emitLog(stream: "stdout" | "stderr", message: string): void;
  claim: OpsTrustedClaim;
}

export interface OpsTrustedClaim {
  readonly fingerprint: string;
  readonly operation: Readonly<OpsOperation>;
  readonly source: "registry" | "trusted-data";
  readonly capability: Readonly<{
    revisionId: string;
    values: Readonly<Record<string, string | number | boolean | null>>;
    trustedConfiguration?: Readonly<TrustedConfigurationPayload>;
  }>;
  readonly admission?: Readonly<{
    commit(): Promise<void>;
    rollback(): Promise<void>;
    release(): Promise<void>;
  }>;
}

export type OpsRuntimeHandler<K extends OpsOperationKind> = (
  operation: Extract<OpsOperation, { kind: K }>,
  context: OpsExecutionContext,
) => Promise<OpsResultFor<K>>;

export type OpsRuntime = {
  [K in OpsOperationKind]: OpsRuntimeHandler<K>;
};

const notWired = async (): Promise<never> => {
  throw new OpsNotWiredError();
};

export function createUnavailableRuntime(): OpsRuntime {
  const handlers = Object.fromEntries(OPS_OPERATION_KINDS.map((kind) => [kind, notWired]));
  return handlers as unknown as OpsRuntime;
}

export async function dispatchOpsOperation<K extends OpsOperationKind>(
  runtime: OpsRuntime,
  operation: Extract<OpsOperation, { kind: K }>,
  context: OpsExecutionContext,
): Promise<OpsResultFor<K>> {
  const handler = runtime[operation.kind] as OpsRuntimeHandler<K>;
  const result = await handler(operation, context);
  return parseOpsResult(operation.kind, result);
}
