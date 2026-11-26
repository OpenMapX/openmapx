import type { FastifyInstance } from "fastify";
import { acknowledgeAttention, listAttention } from "../services/attention";
import { writeAuditLog } from "../utils/audit-log";
import { getAdminSession } from "../utils/require-admin";
import { registerIntegrationAdminRoute } from "./admin-integration-contract";

export async function adminAttentionRoute(app: FastifyInstance): Promise<void> {
  registerIntegrationAdminRoute(app, "listAdminAttention", async () => ({
    items: await listAttention(),
  }));

  registerIntegrationAdminRoute(app, "acknowledgeAdminAttention", async (request, reply) => {
    const { key } = request.params;
    if (!(await acknowledgeAttention(key)))
      return reply.code(404).send({ error: "Attention item not found" });
    await writeAuditLog({
      action: "attention.acknowledge",
      targetId: key,
      actorId: getAdminSession(request).user.id,
      request,
    });
    return reply.code(204).send();
  });
}
