import type { AdminExtensionInstallRequest } from "@openmapx/core/api-contracts";
import { services as coreServices } from "@openmapx/core/server";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { normalizeExtensionInstallPayload } from "../services/extension-install-payload";
import { previewExtensionInstall } from "../services/extension-installer";
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
  normalizeExtensionLocator,
  PLATFORM_VERSION,
  removeExtensionSource,
  resolveDirectExtensionManifest,
  resolveExtensionManifest,
} from "../services/extension-store";
import { ExtensionStoreError } from "../services/extension-store-error";
import { jobRunner } from "../services/job-runner";
import { getServiceRegistry } from "../services/service-registry";
import { writeAuditLog } from "../utils/audit-log";
import { extensionPreviewLimit, storeInstallLimit } from "../utils/rate-limit";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { safeErrorClass, summarizeExternalUrl } from "../utils/safe-log-fields";
import { registerExtensionAdminRoute } from "./admin-extension-contract";

const { computeServiceSecurityRating } = coreServices;

class ExtensionInstallRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 = 400,
  ) {
    super(message);
  }
}

function installFailure(request: FastifyRequest, error: unknown, fallback: string) {
  request.log.warn({ errorClass: safeErrorClass(error) }, fallback);
  return {
    statusCode: error instanceof ExtensionInstallRequestError ? error.statusCode : (400 as const),
    body: {
      error:
        error instanceof ExtensionInstallRequestError || error instanceof ExtensionStoreError
          ? error.message
          : fallback,
    },
  };
}

function assertAdmission(entry: ExtensionCatalogEntry, kill: KillSwitch): void {
  if (kill.removed.has(entry.id)) throw new ExtensionInstallRequestError("Extension delisted");
  if (kill.critical.has(entry.id))
    throw new ExtensionInstallRequestError("Extension flagged critical");
  if (!isExtensionCompatible(entry))
    throw new ExtensionInstallRequestError("Extension requires a newer platform version");
}

async function resolveInstallRequest(body: AdminExtensionInstallRequest): Promise<{
  manifest: coreServices.ExtensionManifest;
  sourceUrl?: string;
  sourceTrust: "verified" | "community";
}> {
  if (body.id) {
    const kill = await getKillSwitch();
    const entry = await getExtensionCatalogEntry(body.id);
    if (!entry) throw new ExtensionInstallRequestError("Extension not found", 404);
    assertAdmission(entry, kill);
    return {
      manifest: await resolveExtensionManifest(entry),
      sourceUrl: entry.manifest ? normalizeExtensionLocator(entry.manifest) : undefined,
      sourceTrust: entry.trust === "verified" ? "verified" : "community",
    };
  }
  if (body.manifestUrl) {
    const sourceUrl = normalizeExtensionLocator(body.manifestUrl);
    const manifest = await resolveDirectExtensionManifest(sourceUrl);
    // The validated identity, never a selector sentinel or supplied trust, owns denial.
    assertAdmission(
      { id: manifest.id, name: manifest.name, minPlatform: manifest.platform },
      await getKillSwitch(),
    );
    return { manifest, sourceUrl, sourceTrust: "community" };
  }
  throw new ExtensionInstallRequestError("Either `id` or `manifestUrl` is required");
}

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
  registerExtensionAdminRoute(app, "listAdminExtensionCatalog", async (request) => {
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
  registerExtensionAdminRoute(app, "getAdminExtensionCatalogEntry", async (request, reply) => {
    const entry = await getExtensionCatalogEntry(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Not found" });
    const kill = await getKillSwitch();

    let components: { kind: string; id: string }[] = [];
    try {
      const manifest = await resolveExtensionManifest(entry);
      components = coreServices.extensionComponentSummary(manifest);
    } catch (err) {
      request.log.warn(
        { errorClass: safeErrorClass(err) },
        "failed to resolve extension manifest for detail",
      );
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
  registerExtensionAdminRoute(app, "listAdminInstalledExtensions", async (request) => {
    const installed = await listInstalledExtensions();
    let registry: ReturnType<typeof getServiceRegistry> | null = null;
    try {
      registry = getServiceRegistry();
    } catch {
      registry = null;
    }
    // Catalog availability must not hide authoritative local inventory/removal.
    // Keep DB reads and output validation outside this optional enrichment boundary.
    let catalog: ExtensionCatalogEntry[] | undefined;
    try {
      catalog = await getExtensionCatalog();
    } catch (error) {
      request.log.warn(
        { errorClass: safeErrorClass(error) },
        "Installed extension update comparison unavailable",
      );
    }
    const catalogMap = new Map(catalog?.map((e) => [e.id, e]));

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
          hasUpdate: entry?.version != null ? entry.version !== ext.installedVersion : null,
          latestVersion: entry?.version ?? null,
        };
      }),
    };
  });

  // POST /admin/extensions/install-preview — resolve and inspect the exact
  // community service snapshots without publishing or starting them.
  registerExtensionAdminRoute(
    app,
    "previewAdminExtensionInstall",
    async (request, reply) => {
      try {
        const resolved = await resolveInstallRequest(request.body ?? {});
        return await previewExtensionInstall(resolved);
      } catch (error) {
        const failure = installFailure(request, error, "Unable to preview extension installation");
        return reply.status(failure.statusCode).send(failure.body);
      }
    },
    { beforeValidation: extensionPreviewLimit.preHandler() },
  );

  // POST /admin/extensions/install — by catalog id or by direct manifest URL.
  registerExtensionAdminRoute(
    app,
    "installAdminExtension",
    async (request, reply) => {
      const body = request.body ?? {};
      const adminSession = getAdminSession(request);
      let resolved: Awaited<ReturnType<typeof resolveInstallRequest>>;
      try {
        resolved = await resolveInstallRequest(body);
      } catch (error) {
        const failure = installFailure(request, error, "Unable to resolve extension installation");
        return reply.status(failure.statusCode).send(failure.body);
      }

      const { manifest, sourceUrl, sourceTrust } = resolved;

      const jobId = await jobRunner.enqueue(
        "extension.install",
        normalizeExtensionInstallPayload({
          manifest,
          sourceUrl,
          sourceTrust,
          actorId: adminSession.user.id,
          hostPortConfirmation: body.hostPortConfirmation,
        }),
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
    { beforeValidation: storeInstallLimit.preHandler() },
  );

  // POST /admin/extensions/update/:id — re-pin to the catalog's current version.
  registerExtensionAdminRoute(
    app,
    "updateAdminExtension",
    async (request, reply) => {
      const { id } = request.params;
      const adminSession = getAdminSession(request);
      let resolved: Awaited<ReturnType<typeof resolveInstallRequest>>;
      try {
        const entry = await getExtensionCatalogEntry(id);
        if (!entry) {
          return reply.status(400).send({ error: "Extension is not in any catalog source" });
        }
        assertAdmission(entry, await getKillSwitch());
        resolved = {
          manifest: await resolveExtensionManifest(entry),
          sourceUrl: entry.manifest ? normalizeExtensionLocator(entry.manifest) : undefined,
          sourceTrust: entry.trust === "verified" ? "verified" : "community",
        };
      } catch (error) {
        const failure = installFailure(request, error, "Unable to resolve extension update");
        return reply.status(failure.statusCode).send(failure.body);
      }
      const { manifest, sourceUrl, sourceTrust } = resolved;

      const jobId = await jobRunner.enqueue(
        "extension.install",
        normalizeExtensionInstallPayload({
          manifest,
          sourceUrl,
          sourceTrust,
          actorId: adminSession.user.id,
          hostPortConfirmation: request.body?.hostPortConfirmation,
        }),
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
    { beforeValidation: storeInstallLimit.preHandler() },
  );

  // DELETE /admin/extensions/:id
  registerExtensionAdminRoute(app, "removeAdminExtension", async (request, reply) => {
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
  registerExtensionAdminRoute(app, "listAdminExtensionSources", async () => {
    return { sources: await listExtensionSources() };
  });

  // POST /admin/extensions/sources
  registerExtensionAdminRoute(app, "addAdminExtensionSource", async (request, reply) => {
    const { url, label } = request.body ?? {};
    if (!url) return reply.status(400).send({ error: "url is required" });
    if (!label) return reply.status(400).send({ error: "label is required" });
    const adminSession = getAdminSession(request);
    try {
      await addExtensionSource(url, label);
    } catch (err) {
      const failure = installFailure(request, err, "Unable to add extension source");
      return reply.status(failure.statusCode).send(failure.body);
    }
    await writeAuditLog({
      actorId: adminSession.user.id,
      action: "extension.add_source",
      details: { sourceUrl: summarizeExternalUrl(url), label },
      request,
    });
    return { ok: true };
  });

  // DELETE /admin/extensions/sources
  registerExtensionAdminRoute(app, "removeAdminExtensionSource", async (request, reply) => {
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
  registerExtensionAdminRoute(app, "refreshAdminExtensionCatalog", async (request) => {
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
