import type {
  DataConfigurationFencePrepareRequest,
  DataConfigurationFenceReceipt,
  DataConfigurationFenceSettleRequest,
  DataControlDelegation,
  DataExecutionIdentity,
  DataExecutionInput,
  DataExecutionStatus,
  LocalDataExecutionKind,
  linkRequestSchema,
} from "@openmapx/core/data-manager-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type postgres from "postgres";
import type z from "zod/v4";
import { requestPrincipal } from "../../auth.js";
import type { DataManagerPrincipal } from "../../principals.js";
import { registerDataManagerRoute } from "../../route-contract.js";

/** Thrown on admission of a transit sync or catalog validation that names a
 * country outside the configured operations profile. */
export class TransitScopeRejected extends Error {
  readonly statusCode = 422;
  readonly code = "outside-operations-profile";
  constructor() {
    super("Countries outside configured operations profile");
  }
}

/** The receiver checks the delegation a caller names, after bearer
 * authentication. A missing receiver never authorizes a compatibility worker. */
export interface DataExecutionReceiver {
  observeReviewedTransit?(request: {
    key: string;
    countries: string[];
    preflightId: string;
    fingerprint: string;
    triggeredBy?: string;
  }): Promise<DataExecutionStatus | null>;
  admitLocal(
    input: DataExecutionInput,
    options?: { triggeredBy?: string; idempotencyKey?: string },
  ): Promise<DataExecutionStatus>;
  /** Admits in-process work as a durable execution. Admission is awaited; the
   * completion settles once the execution is terminal, with the work's value
   * or its failure. The work gets the execution's cancellable database handle. */
  runLocal<T>(
    input: Extract<
      DataExecutionInput,
      { kind: Exclude<LocalDataExecutionKind, "generation-link"> }
    >,
    work: (sql: postgres.Sql) => Promise<T>,
    options?: { triggeredBy?: string },
  ): Promise<{ status: DataExecutionStatus; completion: Promise<T> }>;
  admitMaintenance(
    action: "restart-primary" | "reload-feed-proxy",
    options?: { triggeredBy: "cron" },
  ): Promise<DataExecutionStatus>;
  subscribe(id: string, onEvent: (event: Record<string, unknown>) => void): () => void;
  legacyResult(id: string): Record<string, unknown> | undefined;
  admit(
    input: DataExecutionInput,
    options: {
      operationKey: string;
      requestedDeadlineAt?: number;
      delegation?: DataControlDelegation;
      transportPrincipal: DataManagerPrincipal;
    },
  ): Promise<DataExecutionStatus>;
  /** Applies a generation's hardlink plan, or observes the application its
   * operation key already names. `running` once the request has waited its
   * share and the application has not ended. */
  link(
    request: z.infer<typeof linkRequestSchema>,
    transportPrincipal: DataManagerPrincipal,
  ): Promise<
    | { state: "applied"; linked: number; skipped: number; pruned: number }
    | { state: "running"; status: DataExecutionStatus }
  >;
  inspect(id: string): Promise<DataExecutionStatus | null>;
  lookup(operationKey: string): Promise<DataExecutionStatus | null>;
  requestCancel(identity: DataExecutionIdentity): Promise<DataExecutionStatus>;
  prepareFence(
    input: DataConfigurationFencePrepareRequest,
    transportPrincipal: DataManagerPrincipal,
  ): Promise<DataConfigurationFenceReceipt>;
  inspectFence(
    maintenanceId: string,
    expected: { candidateId: string },
    transportPrincipal: DataManagerPrincipal,
  ): Promise<DataConfigurationFenceReceipt | null>;
  settleFence(
    input: DataConfigurationFenceSettleRequest,
    transportPrincipal: DataManagerPrincipal,
  ): Promise<DataConfigurationFenceReceipt>;
}
/** The authenticated caller; the auth hook admits no request here without one. */
function principal(request: FastifyRequest): DataManagerPrincipal {
  const caller = requestPrincipal(request);
  if (!caller) throw Object.assign(Error("Unauthenticated execution request"), { statusCode: 401 });
  return caller;
}
function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: "Durable data execution receiver is unavailable" });
}
export function registerDataExecutionApi(
  app: FastifyInstance,
  receiver?: DataExecutionReceiver,
): void {
  registerDataManagerRoute(app, "startDataExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    const { input, ...admission } = request.body;
    return reply
      .code(202)
      .send(await receiver.admit(input, { ...admission, transportPrincipal: principal(request) }));
  });
  // Applies a generation's hardlink plan as a data job: under the lease the
  // sender names, under the prepared fence of that sender's maintenance, or,
  // without a lease, exclusively under data-manager's own. Busy and unavailable
  // answers mean nothing was linked; a 500 means links may have changed.
  registerDataManagerRoute(app, "link", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    const outcome = await receiver.link(request.body, principal(request));
    if (outcome.state === "running") return reply.code(202).send(outcome.status);
    const { state: _state, ...counts } = outcome;
    return { ok: true as const, ...counts };
  });
  registerDataManagerRoute(app, "prepareDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    try {
      return await receiver.prepareFence(request.body, principal(request));
    } catch (error) {
      // The agent tells a busy refusal, which wrote nothing, from other conflicts by this name.
      if ((error as Error).message === "configuration_maintenance_busy")
        return reply.code(409).send({ error: "configuration_maintenance_busy" });
      throw error;
    }
  });
  registerDataManagerRoute(app, "inspectDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    const receipt = await receiver.inspectFence(
      request.params.maintenanceId,
      request.query,
      principal(request),
    );
    return (
      receipt ?? reply.code(404).send({ error: "Configuration maintenance identity is unknown" })
    );
  });
  registerDataManagerRoute(app, "settleDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    if (request.params.maintenanceId !== request.body.maintenanceId)
      return reply.code(409).send({ error: "Configuration maintenance identity conflict" });
    return receiver.settleFence(request.body, principal(request));
  });
  registerDataManagerRoute(app, "lookupDataExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return (
      (await receiver.lookup(request.params.operationKey)) ??
      reply.code(404).send({ error: "Execution identity is unknown" })
    );
  });
  registerDataManagerRoute(app, "getDataExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return (
      (await receiver.inspect(request.params.id)) ??
      reply.code(404).send({ error: "Execution identity is unknown" })
    );
  });
  registerDataManagerRoute(app, "cancelDataExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return receiver.requestCancel({ id: request.params.id, ...request.body });
  });
}
