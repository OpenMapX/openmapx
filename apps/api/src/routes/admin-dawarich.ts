import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_POSTGIS_SERVICE_ID,
  DAWARICH_REDIS_SERVICE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  inspectManagedDawarichProvisioning,
  ManagedDawarichProvisioningError,
  provisionManagedDawarich,
  rotateManagedDawarichOidcSecret,
} from "../services/dawarich/provisioning.js";
import { getServiceRegistry } from "../services/service-registry.js";
import { writeAuditLog } from "../utils/audit-log.js";
import { serviceActionLimit } from "../utils/rate-limit.js";
import { getAdminSession, requireAdmin } from "../utils/require-admin.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { registerServiceAdminRoute } from "./admin-service-contract";

const ROTATION_CONFIRMATION = "ROTATE DAWARICH OIDC SECRET";

const EXPECTED_BUNDLE = [
  {
    id: DAWARICH_APP_SERVICE_ID,
    version: "1.19.0",
    image: "freikin/dawarich",
    tag: "1.19.0",
  },
  {
    id: DAWARICH_WORKER_SERVICE_ID,
    version: "1.19.0",
    image: "freikin/dawarich",
    tag: "1.19.0",
  },
  {
    id: DAWARICH_POSTGIS_SERVICE_ID,
    version: "18-3.6",
    image: "ghcr.io/baosystems/postgis",
    tag: "18-3.6",
  },
  {
    id: DAWARICH_REDIS_SERVICE_ID,
    version: "8.10",
    image: "redis",
    tag: "8.10-alpine",
  },
] as const;

function hasExactManagedBundle(): boolean {
  try {
    const registry = getServiceRegistry();
    return EXPECTED_BUNDLE.every((expected) => {
      const service = registry.get(expected.id);
      return (
        service?.manifest.id === expected.id &&
        service.manifest.version === expected.version &&
        service.manifest.container.image === expected.image &&
        service.manifest.container.tag === expected.tag
      );
    });
  } catch {
    return false;
  }
}

function requestInput(
  request: FastifyRequest,
  publicHost?: string,
): {
  headers: Headers;
  actorId: string;
  controllerDomain: string;
  publicHost?: string;
} {
  return {
    headers: fromNodeHeaders(request.headers),
    actorId: getAdminSession(request).user.id,
    controllerDomain: process.env.DOMAIN?.trim() ?? "",
    ...(publicHost === undefined ? {} : { publicHost }),
  };
}

function statusForError(error: ManagedDawarichProvisioningError): 409 | 422 | 503 {
  switch (error.code) {
    case "DAWARICH_INVALID_PUBLIC_HOST":
      return 422;
    case "DAWARICH_OAUTH_CLIENT_CONFLICT":
    case "DAWARICH_DATABASE_SECRET_CONFLICT":
    case "DAWARICH_RAILS_SECRET_CONFLICT":
      return 409;
    case "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED":
    case "DAWARICH_PROVISIONING_FAILED":
      return 503;
  }
}

async function auditFailure(request: FastifyRequest, action: string, code: string): Promise<void> {
  await writeAuditLog({
    actorId: getAdminSession(request).user.id,
    targetId: DAWARICH_APP_SERVICE_ID,
    targetType: "service",
    action,
    details: { outcome: "failure", code },
    request,
  });
}

export async function adminDawarichRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  const actionLimit = serviceActionLimit.preHandler();

  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });

  registerServiceAdminRoute(app, "getAdminDawarich", async (request, reply) => {
    try {
      return await inspectManagedDawarichProvisioning(requestInput(request));
    } catch (error) {
      const code =
        error instanceof ManagedDawarichProvisioningError
          ? error.code
          : "DAWARICH_PROVISIONING_FAILED";
      reply.status(error instanceof ManagedDawarichProvisioningError ? statusForError(error) : 503);
      return { code };
    }
  });

  registerServiceAdminRoute(
    app,
    "provisionAdminDawarich",
    async (request, reply) => {
      const publicHost = request.body?.publicHost;
      try {
        const result = await provisionManagedDawarich(requestInput(request, publicHost));
        await writeAuditLog({
          actorId: getAdminSession(request).user.id,
          targetId: DAWARICH_APP_SERVICE_ID,
          targetType: "service",
          action: "dawarich.provision",
          details: { ...result.audit },
          request,
        });
        return result.status;
      } catch (error) {
        const safeError =
          error instanceof ManagedDawarichProvisioningError
            ? error
            : new ManagedDawarichProvisioningError("DAWARICH_PROVISIONING_FAILED");
        await auditFailure(request, "dawarich.provision", safeError.code);
        reply.status(statusForError(safeError));
        return { code: safeError.code };
      }
    },
    {
      beforeValidation: async (request, reply) => {
        await actionLimit(request, reply);
        if (reply.sent) return;
        if (!hasExactManagedBundle())
          return reply.code(409).send({ code: "DAWARICH_BUNDLE_NOT_INSTALLED" });
        const publicHost = (request.body as { publicHost?: unknown } | undefined)?.publicHost;
        if (publicHost !== undefined && typeof publicHost !== "string")
          return reply.code(422).send({ code: "DAWARICH_INVALID_PUBLIC_HOST" });
      },
    },
  );

  registerServiceAdminRoute(
    app,
    "rotateAdminDawarichOidcSecret",
    async (request, reply) => {
      try {
        const result = await rotateManagedDawarichOidcSecret(requestInput(request));
        await writeAuditLog({
          actorId: getAdminSession(request).user.id,
          targetId: DAWARICH_APP_SERVICE_ID,
          targetType: "service",
          action: "dawarich.rotate_oidc_secret",
          details: { ...result.audit },
          request,
        });
        return result.status;
      } catch (error) {
        const safeError =
          error instanceof ManagedDawarichProvisioningError
            ? error
            : new ManagedDawarichProvisioningError("DAWARICH_PROVISIONING_FAILED");
        await auditFailure(request, "dawarich.rotate_oidc_secret", safeError.code);
        reply.status(statusForError(safeError));
        return { code: safeError.code };
      }
    },
    {
      beforeValidation: async (request, reply) => {
        await actionLimit(request, reply);
        if (reply.sent) return;
        if (!hasExactManagedBundle())
          return reply.code(409).send({ code: "DAWARICH_BUNDLE_NOT_INSTALLED" });
        if (
          (request.body as { confirmation?: unknown } | undefined)?.confirmation !==
          ROTATION_CONFIRMATION
        )
          return reply.code(400).send({ code: "DAWARICH_ROTATION_CONFIRMATION_REQUIRED" });
      },
    },
  );
}
