import { Readable } from "node:stream";
import {
  type OfflineMapPackageManifest,
  type OfflinePackageCapability,
  parseOfflinePackageRequest,
  validateOfflineMapPackageManifest,
} from "@openmapx/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { envString } from "../utils/env.js";
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

function dataManagerUrl(path: string): string {
  const base = envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT).replace(/\/$/, "");
  return `${base}${path}`;
}

function dataManagerHeaders(): HeadersInit {
  const token = envString("DATA_MANAGER_AUTH_TOKEN", "");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function isContentAddressedPackageId(value: string): boolean {
  return PACKAGE_ID_PATTERN.test(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: "Invalid data-manager response" };
  }
}

function validatedManifest(raw: unknown): OfflineMapPackageManifest {
  return validateOfflineMapPackageManifest(raw);
}

function copyArchiveHeaders(response: Response, reply: FastifyReply): void {
  for (const name of ARCHIVE_HEADERS) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
}

function copyAssetHeaders(response: Response, reply: FastifyReply): void {
  for (const name of ASSET_HEADERS) {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  }
}

async function proxyJson(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(dataManagerUrl(path), {
    ...init,
    headers: {
      ...dataManagerHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  return { response, body: await readJson(response) };
}

export const offlinePackagesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");

  fastify.get("/offline/packages/capability", async (_request, reply) => {
    try {
      const { response, body } = await proxyJson("/offline/packages/capability");
      if (!response.ok) {
        return reply.code(502).send({
          available: false,
          provider: "openmapx",
          reason: "source-unavailable",
        } satisfies OfflinePackageCapability);
      }
      const capability = body as OfflinePackageCapability;
      if (capability.provider !== "openmapx" || typeof capability.available !== "boolean") {
        return reply.code(502).send({
          available: false,
          provider: "openmapx",
          reason: "source-unavailable",
        } satisfies OfflinePackageCapability);
      }
      return reply.send(capability);
    } catch (error) {
      fastify.log.warn({ err: error }, "offline package capability unavailable");
      return reply.code(502).send({
        available: false,
        provider: "openmapx",
        reason: "source-unavailable",
      } satisfies OfflinePackageCapability);
    }
  });

  fastify.post("/offline/packages/prepare", async (request, reply) => {
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
      const { response, body: result } = await proxyJson("/offline/packages/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return reply.code(response.status).send(result);
    } catch {
      return reply.code(502).send({ error: "Offline package service unavailable" });
    }
  });

  fastify.get<{ Params: { jobId: string } }>(
    "/offline/packages/jobs/:jobId",
    async (request, reply) => {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(request.params.jobId)) {
        return reply.code(400).send({ error: "Invalid offline package job id" });
      }
      try {
        const { response, body } = await proxyJson(
          `/offline/packages/jobs/${encodeURIComponent(request.params.jobId)}`,
        );
        return reply.code(response.status).send(body);
      } catch {
        return reply.code(502).send({ error: "Offline package service unavailable" });
      }
    },
  );

  fastify.get<{ Params: { packageId: string } }>(
    "/offline/packages/:packageId/manifest",
    async (request, reply) => {
      const { packageId } = request.params;
      if (!isContentAddressedPackageId(packageId)) {
        return reply.code(400).send({ error: "Invalid offline package id" });
      }
      try {
        const { response, body } = await proxyJson(`/offline/packages/${packageId}/manifest`);
        if (response.ok) {
          try {
            return reply.send(validatedManifest(body));
          } catch {
            return reply.code(502).send({ error: "Invalid offline package manifest" });
          }
        }
        return reply.code(response.status).send(body);
      } catch {
        return reply.code(502).send({ error: "Offline package service unavailable" });
      }
    },
  );

  const glyph = async (
    request: FastifyRequest<{ Params: { version: string; "*": string } }>,
    reply: FastifyReply,
  ): Promise<FastifyReply> => {
    const glyphPath = /^([^/]+)\/(\d+-\d+)\.pbf$/.exec(request.params["*"] ?? "");
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(request.params.version) || !glyphPath) {
      return reply.code(400).send({ error: "Invalid offline package glyph identity" });
    }
    const upstreamPath = `${encodeURIComponent(glyphPath[1])}/${glyphPath[2]}.pbf`;
    try {
      const upstream = await fetch(
        dataManagerUrl(`/offline/packages/glyphs/${request.params.version}/${upstreamPath}`),
        {
          method: request.method,
          headers: dataManagerHeaders(),
        },
      );
      copyAssetHeaders(upstream, reply);
      if (!upstream.ok || request.method === "HEAD") {
        const body = request.method === "HEAD" ? undefined : await upstream.text();
        return reply.code(upstream.status).send(body || undefined);
      }
      if (!upstream.body) return reply.code(502).send({ error: "Empty glyph response" });
      return reply.code(upstream.status).send(Readable.fromWeb(upstream.body as never));
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
        const { response, body } = await proxyJson(
          `/offline/packages/glyphs/${request.params.version}/catalog.json`,
        );
        copyAssetHeaders(response, reply);
        return reply.code(response.status).send(body);
      } catch {
        return reply.code(502).send({ error: "Offline package service unavailable" });
      }
    },
  );

  fastify.head<{ Params: { version: string; "*": string } }>(
    "/offline/packages/glyphs/:version/*",
    glyph,
  );
  fastify.get<{ Params: { version: string; "*": string } }>(
    "/offline/packages/glyphs/:version/*",
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
    if (typeof range === "string") headers.Range = range;
    if (typeof ifRange === "string") headers["If-Range"] = ifRange;
    try {
      const upstream = await fetch(dataManagerUrl(`/offline/packages/${packageId}/archive`), {
        method: request.method,
        headers: { ...dataManagerHeaders(), ...headers },
      });
      copyArchiveHeaders(upstream, reply);
      if (!upstream.ok || request.method === "HEAD") {
        const body = request.method === "HEAD" ? undefined : await upstream.text();
        return reply.code(upstream.status).send(body || undefined);
      }
      if (!upstream.body) return reply.code(502).send({ error: "Empty archive response" });
      return reply.code(upstream.status).send(Readable.fromWeb(upstream.body as never));
    } catch {
      return reply.code(502).send({ error: "Offline package service unavailable" });
    }
  };

  fastify.head<{ Params: { packageId: string } }>("/offline/packages/:packageId/archive", archive);
  fastify.get<{ Params: { packageId: string } }>("/offline/packages/:packageId/archive", archive);
};
