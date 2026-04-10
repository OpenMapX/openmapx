import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { installedIntegration } from "../db/schema";
import { jobRunner } from "../services/job-runner";
import {
  addCatalogSource,
  checkForUpdates,
  fetchReadme,
  getCatalog,
  getCatalogEntry,
  isCompatible,
  listCatalogSources,
  PLATFORM_VERSION,
  removeCatalogSource,
} from "../services/store";
import { writeAuditLog } from "../utils/audit-log";
import { storeInstallLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";

export async function adminStoreRoute(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const session = await requireAdmin(request, reply);
    if (!session) return reply;
    request.adminSession = session;
  });

  // GET /admin/store/catalog
  app.get<{
    Querystring: {
      q?: string;
      domain?: string;
      quality?: string;
      sort?: "popular" | "newest" | "updated" | "az";
    };
  }>("/admin/store/catalog", async (request) => {
    const { q, domain, quality, sort = "az" } = request.query;
    let entries = await getCatalog();

    if (q) {
      const lq = q.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(lq) ||
          e.description.toLowerCase().includes(lq) ||
          e.author.toLowerCase().includes(lq) ||
          e.tags.some((t) => t.toLowerCase().includes(lq)),
      );
    }
    if (domain) entries = entries.filter((e) => e.domains.includes(domain));
    if (quality) entries = entries.filter((e) => e.quality === quality);

    const installed = await db.select().from(installedIntegration);
    const installedMap = new Map(installed.map((i) => [i.id, i]));

    entries = entries.slice().sort((a, b) => {
      if (sort === "newest" || sort === "updated") {
        return new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime();
      }
      return a.name.localeCompare(b.name);
    });

    return {
      entries: entries.map((e) => {
        const inst = installedMap.get(e.id);
        return {
          ...e,
          compatible: isCompatible(e),
          platformVersion: PLATFORM_VERSION,
          installed: !!inst,
          installedVersion: inst?.installedVersion ?? null,
          hasUpdate: inst ? inst.installedVersion !== e.version : false,
        };
      }),
      total: entries.length,
    };
  });

  // GET /admin/store/catalog/:id
  app.get<{ Params: { id: string } }>("/admin/store/catalog/:id", async (request, reply) => {
    const entry = await getCatalogEntry(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Not found" });

    const [inst] = await db
      .select()
      .from(installedIntegration)
      .where(eq(installedIntegration.id, entry.id))
      .limit(1);

    const readme = await fetchReadme(entry.repository);

    return {
      ...entry,
      compatible: isCompatible(entry),
      platformVersion: PLATFORM_VERSION,
      installed: !!inst,
      installedVersion: inst?.installedVersion ?? null,
      installedAt: inst?.installedAt?.toISOString() ?? null,
      hasUpdate: inst ? inst.installedVersion !== entry.version : false,
      readme,
    };
  });

  // POST /admin/store/install
  app.post<{ Body: { repository: string; version?: string } }>(
    "/admin/store/install",
    { preHandler: [storeInstallLimit.preHandler()] },
    async (request, reply) => {
      const { repository, version } = request.body ?? {};
      if (!repository) return reply.status(400).send({ error: "repository is required" });

      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue(
        "store.install",
        { repository, version, actorId: adminSession.user.id },
        adminSession.user.id,
      );

      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "store.install",
        targetType: "integration",
        details: { repository, version, jobId },
        request,
      });

      reply.status(202);
      return { jobId };
    },
  );

  // POST /admin/store/update/:id
  app.post<{ Params: { id: string }; Body: { version?: string } }>(
    "/admin/store/update/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { version } = request.body ?? {};

      const [record] = await db
        .select()
        .from(installedIntegration)
        .where(eq(installedIntegration.id, id))
        .limit(1);
      if (!record) return reply.status(404).send({ error: `Integration ${id} is not installed` });

      const adminSession = getAdminSession(request);

      const jobId = await jobRunner.enqueue(
        "store.update",
        { id, version, actorId: adminSession.user.id },
        adminSession.user.id,
      );

      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "store.update",
        targetType: "integration",
        targetId: id,
        details: { version, jobId },
        request,
      });

      reply.status(202);
      return { jobId };
    },
  );

  // DELETE /admin/store/:id
  app.delete<{ Params: { id: string } }>("/admin/store/:id", async (request, reply) => {
    const { id } = request.params;

    const [record] = await db
      .select()
      .from(installedIntegration)
      .where(eq(installedIntegration.id, id))
      .limit(1);
    if (!record) return reply.status(404).send({ error: `Integration ${id} is not installed` });

    const adminSession = getAdminSession(request);

    const jobId = await jobRunner.enqueue(
      "store.remove",
      { id, actorId: adminSession.user.id },
      adminSession.user.id,
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "store.remove",
      targetType: "integration",
      targetId: id,
      details: { jobId },
      request,
    });

    reply.status(202);
    return { jobId };
  });

  // GET /admin/store/installed
  app.get("/admin/store/installed", async () => {
    const installed = await db.select().from(installedIntegration);
    const catalog = await getCatalog();
    const catalogMap = new Map(catalog.map((e) => [e.id, e]));

    return {
      integrations: installed.map((inst) => {
        const entry = catalogMap.get(inst.id);
        return {
          id: inst.id,
          repository: inst.repository,
          installedVersion: inst.installedVersion,
          sourceType: inst.sourceType,
          installedAt: inst.installedAt.toISOString(),
          updatedAt: inst.updatedAt.toISOString(),
          catalogEntry: entry ?? null,
          hasUpdate: entry ? entry.version !== inst.installedVersion : false,
        };
      }),
    };
  });

  // GET /admin/store/updates
  app.get("/admin/store/updates", async () => {
    const updates = await checkForUpdates();
    return { updates, available: updates.filter((u) => u.hasUpdate).length };
  });

  // POST /admin/store/refresh-catalog
  app.post("/admin/store/refresh-catalog", async (request, _reply) => {
    const adminSession = getAdminSession(request);

    const catalog = await getCatalog(true);

    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "store.refresh_catalog",
      details: { entriesLoaded: catalog.length },
      request,
    });

    return { entries: catalog.length };
  });

  // GET /admin/store/sources
  app.get("/admin/store/sources", async () => {
    const sources = await listCatalogSources();
    return { sources };
  });

  // POST /admin/store/sources
  app.post<{ Body: { url: string; label: string } }>(
    "/admin/store/sources",
    async (request, reply) => {
      const { url, label } = request.body ?? {};
      if (!url) return reply.status(400).send({ error: "url is required" });
      if (!label) return reply.status(400).send({ error: "label is required" });

      try {
        new URL(url);
      } catch {
        return reply.status(400).send({ error: "url must be a valid URL" });
      }

      const adminSession = getAdminSession(request);

      try {
        await addCatalogSource(url, label);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "store.add_source",
        details: { url, label },
        request,
      });

      return { ok: true };
    },
  );

  // DELETE /admin/store/sources
  app.delete<{ Body: { url: string } }>("/admin/store/sources", async (request, reply) => {
    const { url } = request.body ?? {};
    if (!url) return reply.status(400).send({ error: "url is required" });

    const adminSession = getAdminSession(request);

    await removeCatalogSource(url);

    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "store.remove_source",
      details: { url },
      request,
    });

    return { ok: true };
  });
}
