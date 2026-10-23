import type {
  BorrowedArtifactTargetLease,
  VerifiedExecutionAuthority,
} from "@openmapx/core/build-artifacts";
import type { TrustedConfigurationPayload } from "@openmapx/core/ops";
import {
  type ExecutionRef,
  OPS_OPERATION_KINDS,
  OPS_PUBLIC_ERROR_MESSAGES,
  type OpsErrorClass,
  type OpsFailureResult,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  parseOpsResult,
} from "@openmapx/core/ops";

export class OpsExecutionFailure extends Error {
  constructor(
    readonly errorClass: OpsErrorClass,
    readonly failureResult: OpsFailureResult,
  ) {
    super(OPS_PUBLIC_ERROR_MESSAGES[errorClass]);
    this.name = "OpsExecutionFailure";
  }
}

export class OpsNotWiredError extends Error {
  constructor() {
    super("Typed adapter is not wired");
    this.name = "OpsNotWiredError";
  }
}

export class OpsHostUpdateRequiredError extends Error {
  constructor() {
    super(OPS_PUBLIC_ERROR_MESSAGES.host_update_required);
    this.name = "OpsHostUpdateRequiredError";
  }
}

/** The agent cannot be replaced while it runs other operations. */
export class OpsAgentBusyError extends Error {
  constructor() {
    super(OPS_PUBLIC_ERROR_MESSAGES.busy);
    this.name = "OpsAgentBusyError";
  }
}

export interface OpsExecutionContext {
  readonly execution: ExecutionRef;
  readonly artifactLease?: BorrowedArtifactTargetLease;
  readonly controlAuthority?: VerifiedExecutionAuthority;
  signal: AbortSignal;
  emitLog(stream: "stdout" | "stderr", message: string): void;
  claim: OpsTrustedClaim;
  /** Unfinished operations other than this one; replacing the agent would end them. */
  otherActiveOperations?(): number;
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

type OpsRuntimeHandler<K extends OpsOperationKind> = (
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
