import type {
  DataConfigurationFencePrepareRequest,
  DataConfigurationFenceReceipt,
  DataConfigurationFenceSettleRequest,
  DataControlDelegation,
  DataExecutionIdentity,
  DataExecutionInput,
  DataExecutionStatus,
  LocalDataExecutionKind,
  startGenerationHardlinksExecutionSchema,
} from "@openmapx/core/data-manager-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type z from "zod/v4";
import { requestPrincipal } from "../../auth.js";
import type { DataManagerPrincipal } from "../../principals.js";
import { registerDataManagerRoute } from "../../route-contract.js";

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
   * or its failure. */
  runLocal<T>(
    input: Extract<DataExecutionInput, { kind: LocalDataExecutionKind }>,
    work: () => Promise<T>,
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
  admitHardlinks(
    request: z.infer<typeof startGenerationHardlinksExecutionSchema>,
    transportPrincipal: DataManagerPrincipal,
  ): Promise<DataExecutionStatus>;
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
  registerDataManagerRoute(app, "startGenerationHardlinksExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return reply.code(202).send(await receiver.admitHardlinks(request.body, principal(request)));
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
