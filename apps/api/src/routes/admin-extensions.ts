import { services as coreServices } from "@openmapx/core/server";
import type { FastifyInstance } from "fastify";
import {
  addExtensionSource,
  type ExtensionCatalogEntry,
  getExtensionCatalog,
  getExtensionCatalogEntry,
  getKillSwitch,
  isExtensionCompatible,
  type KillSwitch,
  listExtensionSources,
  listInstalledExtensions,
  PLATFORM_VERSION,
  removeExtensionSource,
  resolveExtensionManifest,
} from "../services/extension-store";
import { jobRunner } from "../services/job-runner";
import { getServiceRegistry } from "../services/service-registry";
import { writeAuditLog } from "../utils/audit-log";
import { storeInstallLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { summarizeExternalUrl } from "../utils/safe-log-fields";

const { computeServiceSecurityRating } = coreServices;

function componentCounts(entry: ExtensionCatalogEntry): { services: number; integrations: number } {
  return {
    services: entry.services?.length ?? 0,
    integrations: entry.integrations?.length ?? 0,
  };
}

export type ExtensionStatus = "verified" | "community" | "revoked" | "stale-revocation-data";

/**
 * Revocation outranks trust: a revoked extension is revoked whatever tier it
 * came from. When the deny-only feed could not be refreshed the entry is
 * reported as `stale-revocation-data` rather than silently as clean, so an
 * administrator can tell "not revoked" from "not checked".
 */
function extensionStatus(entry: ExtensionCatalogEntry, kill: KillSwitch): ExtensionStatus {
  if (kill.removed.has(entry.id) || kill.critical.has(entry.id)) return "revoked";
  if (kill.stale) return "stale-revocation-data";
  return entry.trust === "verified" ? "verified" : "community";
}

export async function adminExtensionsRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  // GET /admin/extensions/catalog
  app.get<{
    Querystring: { q?: string; category?: string; trust?: string; type?: string; sort?: string };
  }>("/admin/extensions/catalog", async (request) => {
    const { q, category, trust, type, sort = "az" } = request.query;
    let entries = await getExtensionCatalog();
    const kill = await getKillSwitch();
    const installed = await listInstalledExtensions();
    const installedMap = new Map(installed.map((i) => [i.id, i]));

    if (q) {
      const lq = q.toLowerCase();
      entries = entries.filter(
        (e) =>
          e.name.toLowerCase().includes(lq) ||
          (e.summary ?? "").toLowerCase().includes(lq) ||
          (e.author ?? "").toLowerCase().includes(lq) ||
          (e.tags ?? []).some((t) => t.toLowerCase().includes(lq)),
      );
    }
    if (category) entries = entries.filter((e) => (e.categories ?? []).includes(category));
    if (trust) entries = entries.filter((e) => e.trust === trust);
    if (type === "service") entries = entries.filter((e) => (e.services?.length ?? 0) > 0);
    if (type === "integration") entries = entries.filter((e) => (e.integrations?.length ?? 0) > 0);

    entries = entries.slice().sort((a, b) => {
      if (sort === "newest" || sort === "updated") {
        return new Date(b.lastUpdated ?? 0).getTime() - new Date(a.lastUpdated ?? 0).getTime();
      }
      return a.name.localeCompare(b.name);
    });

    return {
      entries: entries.map((e) => {
        const inst = installedMap.get(e.id);
        return {
          ...e,
          components: componentCounts(e),
          compatible: isExtensionCompatible(e),
          platformVersion: PLATFORM_VERSION,
          installed: !!inst,
          installedVersion: inst?.installedVersion ?? null,
          // No spurious update when the live version is unknown (manifest fetch failed).
          hasUpdate: !!inst && e.version != null && inst.installedVersion !== e.version,
          removed: kill.removed.has(e.id) ? kill.removed.get(e.id) : null,
          critical: kill.critical.has(e.id) ? kill.critical.get(e.id) : null,
          // `verified` | `community` | `revoked` | `stale-revocation-data` are
          // distinct states. "We could not check" must never render as "clean".
          status: extensionStatus(e, kill),
        };
      }),
      total: entries.length,
      revocationDataStale: kill.stale,
    };
  });

  // GET /admin/extensions/catalog/:id
  app.get<{ Params: { id: string } }>("/admin/extensions/catalog/:id", async (request, reply) => {
    const entry = await getExtensionCatalogEntry(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Not found" });
    const kill = await getKillSwitch();

    let components: { kind: string; id: string }[] = [];
    try {
      const manifest = await resolveExtensionManifest(entry);
      components = coreServices.extensionComponentSummary(manifest);
    } catch (err) {
      request.log.warn({ err }, "failed to resolve extension manifest for detail");
    }

    return {
      ...entry,
      componentList: components,
      compatible: isExtensionCompatible(entry),
      platformVersion: PLATFORM_VERSION,
      removed: kill.removed.get(entry.id) ?? null,
      critical: kill.critical.get(entry.id) ?? null,
    };
  });

  // GET /admin/extensions/installed
  app.get("/admin/extensions/installed", async () => {
    const installed = await listInstalledExtensions();
    let registry: ReturnType<typeof getServiceRegistry> | null = null;
    try {
      registry = getServiceRegistry();
    } catch {
      registry = null;
    }
    const catalog = await getExtensionCatalog();
    const catalogMap = new Map(catalog.map((e) => [e.id, e]));

    return {
      extensions: installed.map((ext) => {
        const entry = catalogMap.get(ext.id);
        const components = ext.components.map((c) => {
          if (c.kind === "service" && registry) {
            const svc = registry.get(c.componentId);
            if (svc) {
              return {
                ...c,
                enabled: svc.enabled,
                securityRating: computeServiceSecurityRating(svc.manifest),
              };
            }
          }
          return c;
        });
        return {
          id: ext.id,
          name: ext.name,
          sourceTrust: ext.sourceTrust,
          installedVersion: ext.installedVersion,
          sourceUrl: ext.sourceUrl,
          installedAt: ext.installedAt.toISOString(),
          updatedAt: ext.updatedAt.toISOString(),
          components,
          hasUpdate: !!entry && entry.version != null && entry.version !== ext.installedVersion,
          latestVersion: entry?.version ?? null,
        };
      }),
    };
  });

  // POST /admin/extensions/install — by catalog id or by direct manifest URL.
  app.post<{ Body: { id?: string; manifestUrl?: string } }>(
    "/admin/extensions/install",
    { preHandler: [storeInstallLimit.preHandler()] },
    async (request, reply) => {
      const body = request.body ?? {};
      const adminSession = getAdminSession(request);
      const kill = await getKillSwitch();

      let manifest: coreServices.ExtensionManifest;
      let sourceUrl: string | undefined;
      let sourceTrust: "verified" | "community" = "community";

      if (body.id) {
        const entry = await getExtensionCatalogEntry(body.id);
        if (!entry) return reply.status(404).send({ error: `Extension ${body.id} not found` });
        if (kill.removed.has(entry.id)) {
          return reply
            .status(400)
            .send({ error: `Extension delisted: ${kill.removed.get(entry.id)}` });
        }
        if (kill.critical.has(entry.id)) {
          return reply.status(400).send({
            error: `Extension flagged critical: ${kill.critical.get(entry.id)?.reason}`,
          });
        }
        if (!isExtensionCompatible(entry)) {
          return reply.status(400).send({
            error: `Requires platform >= ${entry.minPlatform} (this is ${PLATFORM_VERSION})`,
          });
        }
        try {
          manifest = await resolveExtensionManifest(entry);
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        sourceUrl = entry.manifest ?? undefined;
        sourceTrust = entry.trust === "verified" ? "verified" : "community";
      } else if (body.manifestUrl) {
        try {
          manifest = await resolveExtensionManifest({
            id: "_direct",
            name: "_direct",
            version: "_",
            manifest: body.manifestUrl,
          });
        } catch (err) {
          return reply.status(400).send({ error: (err as Error).message });
        }
        sourceUrl = body.manifestUrl;
        sourceTrust = "community";
      } else {
        return reply.status(400).send({ error: "Either `id` or `manifestUrl` is required" });
      }

      const jobId = await jobRunner.enqueue(
        "extension.install",
        { manifest, sourceUrl, sourceTrust, actorId: adminSession.user.id },
        adminSession.user.id,
      );

      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "extension.install",
        targetType: "extension",
        targetId: manifest.id,
        details: {
          version: manifest.version,
          sourceTrust,
          sourceUrl: sourceUrl ? summarizeExternalUrl(sourceUrl) : undefined,
          jobId,
        },
        request,
      });

      reply.status(202);
      return { jobId };
    },
  );

  // POST /admin/extensions/update/:id — re-pin to the catalog's current version.
  app.post<{ Params: { id: string } }>(
    "/admin/extensions/update/:id",
    { preHandler: [storeInstallLimit.preHandler()] },
    async (request, reply) => {
      const { id } = request.params;
      const adminSession = getAdminSession(request);
      const entry = await getExtensionCatalogEntry(id);
      if (!entry) {
        return reply.status(400).send({ error: "Extension is not in any catalog source" });
      }
      let manifest: coreServices.ExtensionManifest;
      try {
        manifest = await resolveExtensionManifest(entry);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }

      const jobId = await jobRunner.enqueue(
        "extension.install",
        {
          manifest,
          sourceUrl: entry.manifest ?? undefined,
          sourceTrust: entry.trust === "verified" ? "verified" : "community",
          actorId: adminSession.user.id,
        },
        adminSession.user.id,
      );

      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "extension.update",
        targetType: "extension",
        targetId: id,
        details: { version: manifest.version, jobId },
        request,
      });

      reply.status(202);
      return { jobId };
    },
  );

  // DELETE /admin/extensions/:id
  app.delete<{ Params: { id: string } }>("/admin/extensions/:id", async (request, reply) => {
    const { id } = request.params;
    const adminSession = getAdminSession(request);

    const jobId = await jobRunner.enqueue(
      "extension.remove",
      { id, actorId: adminSession.user.id },
      adminSession.user.id,
    );

    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "extension.remove",
      targetType: "extension",
      targetId: id,
      details: { jobId },
      request,
    });

    reply.status(202);
    return { jobId };
  });

  // GET /admin/extensions/sources
  app.get("/admin/extensions/sources", async () => {
    return { sources: await listExtensionSources() };
  });

  // POST /admin/extensions/sources
  app.post<{ Body: { url: string; label: string } }>(
    "/admin/extensions/sources",
    async (request, reply) => {
      const { url, label } = request.body ?? {};
      if (!url) return reply.status(400).send({ error: "url is required" });
      if (!label) return reply.status(400).send({ error: "label is required" });
      const adminSession = getAdminSession(request);
      try {
        await addExtensionSource(url, label);
      } catch (err) {
        return reply.status(400).send({ error: (err as Error).message });
      }
      await writeAuditLog({
        actorId: adminSession.user.id,
        action: "extension.add_source",
        details: { sourceUrl: summarizeExternalUrl(url), label },
        request,
      });
      return { ok: true };
    },
  );

  // DELETE /admin/extensions/sources
  app.delete<{ Body: { url: string } }>("/admin/extensions/sources", async (request, reply) => {
    const { url } = request.body ?? {};
    if (!url) return reply.status(400).send({ error: "url is required" });
    const adminSession = getAdminSession(request);
    await removeExtensionSource(url);
    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "extension.remove_source",
      details: { sourceUrl: summarizeExternalUrl(url) },
      request,
    });
    return { ok: true };
  });

  // POST /admin/extensions/refresh-catalog
  app.post("/admin/extensions/refresh-catalog", async (request) => {
    const adminSession = getAdminSession(request);
    const catalog = await getExtensionCatalog(true);
    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "extension.refresh_catalog",
      details: { entriesLoaded: catalog.length },
      request,
    });
    return { entries: catalog.length };
  });
}
