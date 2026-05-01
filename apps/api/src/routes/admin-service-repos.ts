import type { FastifyInstance } from "fastify";
import {
  listRepos,
  previewRepo,
  refreshRepo,
  registerRepo,
  removeRepo,
} from "../services/service-repositories";
import { requireAdmin } from "../utils/require-admin";

export async function registerAdminServiceReposRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: accept any Fastify logger variant
  app: FastifyInstance<any, any, any, any>,
): Promise<void> {
  // GET /api/admin/service-repos — list all registered community repos
  app.get("/api/admin/service-repos", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    return { repos: await listRepos() };
  });

  // POST /api/admin/service-repos/preview — shallow-clone + validate, no DB write
  app.post<{ Body: { url: string } }>("/api/admin/service-repos/preview", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    const { url } = req.body ?? {};
    if (!url) {
      reply.status(400);
      return { error: "url required" };
    }
    try {
      const preview = await previewRepo(url);
      return preview;
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // POST /api/admin/service-repos — register a community repo (requires acknowledgeRisks)
  app.post<{ Body: { url: string; acknowledgeRisks: boolean } }>(
    "/api/admin/service-repos",
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      if (!req.body?.acknowledgeRisks) {
        reply.status(400);
        return { error: "acknowledgeRisks flag must be true for community repos" };
      }
      if (!req.body.url) {
        reply.status(400);
        return { error: "url required" };
      }
      try {
        const row = await registerRepo(req.body.url);
        return { repo: row };
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }
    },
  );

  // DELETE /api/admin/service-repos/:hash — remove repo + cloned directory
  app.delete<{ Params: { hash: string } }>("/api/admin/service-repos/:hash", async (req, reply) => {
    const session = await requireAdmin(req, reply);
    if (!session) return;
    try {
      await removeRepo(req.params.hash);
      return { ok: true };
    } catch (err) {
      reply.status(400);
      return { error: (err as Error).message };
    }
  });

  // POST /api/admin/service-repos/:hash/refresh — git fetch + reset to origin/HEAD
  app.post<{ Params: { hash: string } }>(
    "/api/admin/service-repos/:hash/refresh",
    async (req, reply) => {
      const session = await requireAdmin(req, reply);
      if (!session) return;
      try {
        const row = await refreshRepo(req.params.hash);
        if (!row) {
          reply.status(404);
          return { error: "repo not found" };
        }
        return { repo: row };
      } catch (err) {
        reply.status(400);
        return { error: (err as Error).message };
      }
    },
  );
}
