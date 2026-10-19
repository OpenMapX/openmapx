import { Readable } from "node:stream";
import { type OfflinePackageCapability, parseOfflinePackageRequest } from "@openmapx/core";
import * as dm from "@openmapx/core/data-manager-sdk";
import { envString } from "@openmapx/core/server-env";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { redis } from "../redis.js";
import {
  deriveOfflinePackagePrincipal,
  OfflinePackagePrepareRateLimiter,
  readOfflinePackagePrincipalKeyFile,
} from "../services/offline-package-principal.js";
import { getUserId, requireAuthHook } from "../utils/require-auth.js";
import { declareRouteAuth } from "../utils/route-auth.js";

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";
const PACKAGE_ID_PATTERN = /^omp2-[0-9a-f]{64}$/;
const ARCHIVE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
] as const;
const ASSET_HEADERS = ["cache-control", "content-length", "content-type", "etag"] as const;
const PRINCIPAL_HEADER = "x-offline-package-principal";
const PRINCIPAL_KEY_FILE_DEFAULT = "/run/secrets/offline-package-principal-key";

interface PrepareLimiter {
  consume(principal: string): Promise<{ allowed: boolean; retryAfterSeconds: number }>;
}

export interface OfflinePackagesRouteOptions {
  principalKey?: Buffer;
  prepareLimiter?: PrepareLimiter;
}

function dataManagerOptions() {
  return {
    transport: dm.createDataManagerTransport({
      baseUrl: envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
      authToken: envString("DATA_MANAGER_AUTH_TOKEN", ""),
    }),
  };
}

function isContentAddressedPackageId(value: string): boolean {
  return PACKAGE_ID_PATTERN.test(value);
}

function copyArchiveHeaders(response: { headers: Headers }, reply: FastifyReply): void {
  for (const name of ARCHIVE_HEADERS) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
}

function copyAssetHeaders(response: { headers: Headers }, reply: FastifyReply): void {
  for (const name of ASSET_HEADERS) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
}

export function createOfflinePackagesRoute(
  options: OfflinePackagesRouteOptions = {},
): FastifyPluginAsync {
  return async (fastify) => {
    declareRouteAuth(fastify, "public");

    fastify.get("/offline/packages/capability", async (_request, reply) => {
      try {
        const response = await dm.getOfflinePackageCapability(dataManagerOptions());
        if (response.status !== 200) {
          return reply.code(502).send({
            available: false,
            provider: "openmapx",
            reason: "source-unavailable",
          } satisfies OfflinePackageCapability);
        }
        return reply.send(response.data);
      } catch (error) {
        fastify.log.warn({ err: error }, "offline package capability unavailable");
        return reply.code(502).send({
          available: false,
          provider: "openmapx",
          reason: "source-unavailable",
        } satisfies OfflinePackageCapability);
      }
    });

    let dependencies: Promise<{ principalKey: Buffer; prepareLimiter: PrepareLimiter }> | undefined;
    const loadDependencies = async (): Promise<{
      principalKey: Buffer;
      prepareLimiter: PrepareLimiter;
    }> => {
      dependencies ??= (async () => {
        const principalKey =
          options.principalKey ??
          (await readOfflinePackagePrincipalKeyFile(
            envString("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", PRINCIPAL_KEY_FILE_DEFAULT),
          ));
        const prepareLimiter =
          options.prepareLimiter ??
          (redis ? new OfflinePackagePrepareRateLimiter(redis) : undefined);
        if (!prepareLimiter) {
          throw new Error("Offline package preparation requires the distributed Redis quota store");
        }
        return { principalKey, prepareLimiter };
      })();
      return await dependencies;
    };

    await fastify.register(async (authenticated) => {
      declareRouteAuth(authenticated, "session");
      authenticated.addHook("onRequest", async (_request, reply) => {
        reply.header("Cache-Control", "private, no-store");
        reply.header("Pragma", "no-cache");
        reply.header("Referrer-Policy", "no-referrer");
        reply.header("Vary", "Cookie");
      });
      authenticated.addHook("preHandler", requireAuthHook);

      authenticated.post("/offline/packages/prepare", async (request, reply) => {
        let principalKey: Buffer;
        let prepareLimiter: PrepareLimiter;
        try {
          ({ principalKey, prepareLimiter } = await loadDependencies());
        } catch {
          return reply.code(503).send({
            ok: false,
            errorCode: "prepare-quota-unavailable",
            errorMessage: "Offline package preparation quota is temporarily unavailable",
          });
        }
        const principal = deriveOfflinePackagePrincipal(getUserId(request), principalKey);
        let limit: Awaited<ReturnType<PrepareLimiter["consume"]>>;
        try {
          limit = await prepareLimiter.consume(principal);
        } catch {
          return reply.code(503).send({
            ok: false,
            errorCode: "prepare-quota-unavailable",
            errorMessage: "Offline package preparation quota is temporarily unavailable",
          });
        }
        if (!limit.allowed) {
          reply.header("Retry-After", String(limit.retryAfterSeconds));
          return reply.code(429).send({
            ok: false,
            errorCode: "prepare-rate-limit",
            errorMessage: "Offline package preparation quota exceeded",
            retryAfterSeconds: limit.retryAfterSeconds,
          });
        }

        let body: ReturnType<typeof parseOfflinePackageRequest>;
        try {
          body = parseOfflinePackageRequest(request.body);
        } catch (error) {
          return reply.code(400).send({
            errorCode: "invalid-request",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          const response = await dm.prepareOfflinePackage(
            body,
            { [PRINCIPAL_HEADER]: principal },
            dataManagerOptions(),
          );
          const result = response.data;
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter && /^\d+$/.test(retryAfter)) reply.header("Retry-After", retryAfter);
          return reply.code(response.status).send(result);
        } catch {
          return reply.code(502).send({ error: "Offline package service unavailable" });
        }
      });

      authenticated.get<{ Params: { jobId: string } }>(
        "/offline/packages/jobs/:jobId",
        async (request, reply) => {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.jobId)) {
            return reply.code(400).send({ error: "Invalid offline package job id" });
          }
          let principalKey: Buffer;
          try {
            ({ principalKey } = await loadDependencies());
          } catch {
            return reply.code(503).send({ error: "Offline package service unavailable" });
          }
          const principal = deriveOfflinePackagePrincipal(getUserId(request), principalKey);
          try {
            const response = await dm.getOfflinePackageJob(
              request.params.jobId,
              { [PRINCIPAL_HEADER]: principal },
              dataManagerOptions(),
            );
            const body = response.data;
            return reply.code(response.status).send(body);
          } catch {
            return reply.code(502).send({ error: "Offline package service unavailable" });
          }
        },
      );
    });

    fastify.get<{ Params: { packageId: string } }>(
      "/offline/packages/:packageId/manifest",
      async (request, reply) => {
        const { packageId } = request.params;
        if (!isContentAddressedPackageId(packageId)) {
          return reply.code(400).send({ error: "Invalid offline package id" });
        }
        try {
          const response = await dm.getOfflinePackageManifest(packageId, dataManagerOptions());
          const body = response.data;
          return reply.code(response.status).send(body);
        } catch (error) {
          if (error instanceof dm.DataManagerContractError && error.status === 200)
            return reply.code(502).send({ error: "Invalid offline package manifest" });
          return reply.code(502).send({ error: "Offline package service unavailable" });
        }
      },
    );

    const glyph = async (
      request: FastifyRequest<{ Params: { version: string; fontstack: string; range: string } }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { version, fontstack, range } = request.params;
      if (
        !/^[A-Za-z0-9_-]{1,256}$/.test(version) ||
        !fontstack ||
        /[/\\]/.test(fontstack) ||
        !/^\d+-\d+$/.test(range)
      ) {
        return reply.code(400).send({ error: "Invalid offline package glyph identity" });
      }
      try {
        const result = await (request.method === "HEAD"
          ? dm.headOfflineGlyph(version, fontstack, range, dataManagerOptions())
          : dm.getOfflineGlyph(version, fontstack, range, dataManagerOptions()));
        copyAssetHeaders(result, reply);
        if (request.method === "HEAD") return reply.code(result.status).send();
        if (!(result.data instanceof Response)) return reply.code(result.status).send(result.data);
        if (!result.data.body) return reply.code(502).send({ error: "Empty glyph response" });
        return reply.code(result.status).send(Readable.fromWeb(result.data.body as never));
      } catch {
        return reply.code(502).send({ error: "Offline package service unavailable" });
      }
    };

    fastify.get<{ Params: { version: string } }>(
      "/offline/packages/glyphs/:version/catalog.json",
      async (request, reply) => {
        if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.params.version)) {
          return reply.code(400).send({ error: "Invalid offline glyph version" });
        }
        try {
          const response = await dm.getOfflineGlyphCatalog(
            request.params.version,
            dataManagerOptions(),
          );
          const body = response.data;
          copyAssetHeaders(response, reply);
          return reply.code(response.status).send(body);
        } catch {
          return reply.code(502).send({ error: "Offline package service unavailable" });
        }
      },
    );

    fastify.head<{ Params: { version: string; fontstack: string; range: string } }>(
      "/offline/packages/glyphs/:version/:fontstack/:range.pbf",
      glyph,
    );
    fastify.get<{ Params: { version: string; fontstack: string; range: string } }>(
      "/offline/packages/glyphs/:version/:fontstack/:range.pbf",
      glyph,
    );

    const archive = async (
      request: FastifyRequest<{ Params: { packageId: string } }>,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const { packageId } = request.params;
      if (!isContentAddressedPackageId(packageId)) {
        return reply.code(400).send({ error: "Invalid offline package id" });
      }
      const headers: Record<string, string> = {};
      const range = request.headers.range;
      const ifRange = request.headers["if-range"];
      if (typeof range === "string") headers.range = range;
      if (typeof ifRange === "string") headers["if-range"] = ifRange;
      try {
        const result = await (request.method === "HEAD"
          ? dm.headOfflinePackageArchive(packageId, headers, dataManagerOptions())
          : dm.getOfflinePackageArchive(packageId, headers, dataManagerOptions()));
        copyArchiveHeaders(result, reply);
        if (request.method === "HEAD") return reply.code(result.status).send();
        if (!(result.data instanceof Response)) return reply.code(result.status).send(result.data);
        if (!result.data.body) return reply.code(502).send({ error: "Empty archive response" });
        return reply.code(result.status).send(Readable.fromWeb(result.data.body as never));
      } catch {
        return reply.code(502).send({ error: "Offline package service unavailable" });
      }
    };

    fastify.head<{ Params: { packageId: string } }>(
      "/offline/packages/:packageId/archive",
      archive,
    );
    fastify.get<{ Params: { packageId: string } }>("/offline/packages/:packageId/archive", archive);
  };
}

export const offlinePackagesRoute: FastifyPluginAsync = createOfflinePackagesRoute();
