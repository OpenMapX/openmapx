import type {
  DataConfigurationFencePrepare,
  DataConfigurationFenceReceipt,
  DataConfigurationFenceSettle,
  DataExecutionIdentity,
  DataExecutionInput,
  DataExecutionStatus,
  startGenerationHardlinksExecutionSchema,
} from "@openmapx/core/data-manager-contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type z from "zod/v4";
import { registerDataManagerRoute } from "../../route-contract.js";

/** The receiver performs signed admission/adoption, separately from bearer
 * authentication. A missing receiver never authorizes a compatibility worker. */
export interface DataExecutionReceiver {
  admitLocal(
    input: DataExecutionInput,
    options?: { sourceJobId?: string; triggeredBy?: string; legacyTransitKey?: string },
  ): Promise<DataExecutionStatus>;
  admitMaintenance(
    action: "restart-primary" | "reload-feed-proxy",
    options?: { triggeredBy: "cron" },
  ): Promise<DataExecutionStatus>;
  subscribe(id: string, onEvent: (event: Record<string, unknown>) => void): () => void;
  legacyResult(id: string): Record<string, unknown> | undefined;
  admit(
    input: DataExecutionInput,
    options: { operationKey: string; requestedDeadlineAt?: number; rawHeaders: readonly string[] },
  ): Promise<DataExecutionStatus>;
  admitHardlinks(
    request: z.infer<typeof startGenerationHardlinksExecutionSchema>,
    rawHeaders: readonly string[],
  ): Promise<DataExecutionStatus>;
  inspect(id: string): Promise<DataExecutionStatus | null>;
  lookup(operationKey: string): Promise<DataExecutionStatus | null>;
  requestCancel(identity: DataExecutionIdentity): Promise<DataExecutionStatus>;
  prepareFence(
    input: DataConfigurationFencePrepare,
    rawHeaders: readonly string[],
  ): Promise<DataConfigurationFenceReceipt>;
  inspectFence(
    maintenanceId: string,
    rawHeaders: readonly string[],
  ): Promise<DataConfigurationFenceReceipt | null>;
  settleFence(
    input: DataConfigurationFenceSettle,
    rawHeaders: readonly string[],
  ): Promise<DataConfigurationFenceReceipt>;
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
      .send(await receiver.admit(input, { ...admission, rawHeaders: request.raw.rawHeaders }));
  });
  registerDataManagerRoute(app, "startGenerationHardlinksExecution", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return reply
      .code(202)
      .send(await receiver.admitHardlinks(request.body, request.raw.rawHeaders));
  });
  registerDataManagerRoute(app, "prepareDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    return receiver.prepareFence(request.body, request.raw.rawHeaders);
  });
  registerDataManagerRoute(app, "inspectDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    const receipt = await receiver.inspectFence(
      request.params.maintenanceId,
      request.raw.rawHeaders,
    );
    return (
      receipt ?? reply.code(404).send({ error: "Configuration maintenance identity is unknown" })
    );
  });
  registerDataManagerRoute(app, "settleDataConfigurationFence", async (request, reply) => {
    if (!receiver) return unavailable(reply);
    if (request.params.maintenanceId !== request.body.maintenanceId)
      return reply.code(409).send({ error: "Configuration maintenance identity conflict" });
    return receiver.settleFence(request.body, request.raw.rawHeaders);
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
