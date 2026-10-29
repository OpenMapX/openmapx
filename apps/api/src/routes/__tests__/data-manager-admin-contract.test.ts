import { createApiClient } from "@openmapx/core";
import { postApiDataManagerTransitSync } from "@openmapx/core/api-admin-sdk";
import { dataManagerAdminOperations } from "@openmapx/core/api-contracts";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataManagerAdminRoute } from "../data-manager-admin-contract";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("application administration contract registration", () => {
  it("registers the canonical relative path and documents its actual auth", async () => {
    const app = Fastify();
    const registered: Array<{ url: string; auth: unknown }> = [];
    app.addHook("onRoute", (route) => {
      if (route.method !== "HEAD")
        registered.push({
          url: route.url,
          auth: (route.config as { auth?: unknown } | undefined)?.auth,
        });
    });
    await app.register(
      async (child) =>
        registerDataManagerAdminRoute(child, "getApiDataManagerProviders", async (_req, reply) =>
          reply.header("cache-control", "no-store").send({ providers: [] }),
        ),
      { prefix: "/api" },
    );
    try {
      const response = await app.inject("/api/data-manager/providers");
      expect(response.statusCode).toBe(200);
      expect(registered).toEqual([
        { url: dataManagerAdminOperations.getApiDataManagerProviders.path, auth: "service" },
      ]);
    } finally {
      await app.close();
    }
  });
  it("rejects malformed successful producer output before it can lose fields", async () => {
    const app = Fastify();
    registerDataManagerAdminRoute(app, "getApiDataManagerTransitState", async () => ({
      feedCount: 0,
    }));
    try {
      const response = await app.inject("/data-manager/transit/state");
      expect(response.statusCode).toBe(500);
    } finally {
      await app.close();
    }
  });
  it("preserves framework body-limit and unsupported-media statuses", async () => {
    const app = Fastify({ bodyLimit: 128 });
    let calls = 0;
    registerDataManagerAdminRoute(app, "postApiDataManagerTransitSync", async (_req, reply) => {
      calls++;
      return reply.code(202).send({ ok: true, jobId: "job", status: "started" });
    });
    try {
      const media = await app.inject({
        method: "POST",
        url: "/data-manager/transit/sync",
        headers: { "content-type": "application/xml" },
        payload: "<request/>",
      });
      expect(media.statusCode).toBe(415);
      const oversized = await app.inject({
        method: "POST",
        url: "/data-manager/transit/sync",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ idempotencyKey: "x".repeat(200) }),
      });
      expect(oversized.statusCode).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await app.close();
    }
  });
  it("validates real framework parser responses through the generated SDK without replacing their message", async () => {
    const app = Fastify({ bodyLimit: 128 });
    const baseline = Fastify({ bodyLimit: 128 });
    baseline.post("/baseline", async () => ({ ok: true }));
    let calls = 0;
    await app.register(
      async (child) =>
        registerDataManagerAdminRoute(
          child,
          "postApiDataManagerTransitSync",
          async (_req, reply) => {
            calls++;
            return reply.code(202).send({ ok: true, jobId: "job", status: "started" });
          },
        ),
      { prefix: "/api" },
    );
    vi.stubGlobal("fetch", administrationSdkFetch(app));
    const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
    const oversizedBody = { idempotencyKey: "x".repeat(200) };
    try {
      const media = await baseline.inject({
        method: "POST",
        url: "/baseline",
        headers: { "content-type": "application/xml" },
        payload: "<request/>",
      });
      const oversized = await baseline.inject({
        method: "POST",
        url: "/baseline",
        headers: { "content-type": "application/json" },
        payload: JSON.stringify(oversizedBody),
      });
      expect(media.statusCode).toBe(415);
      expect(oversized.statusCode).toBe(413);
      await expect(
        postApiDataManagerTransitSync(
          {},
          { client, headers: { "Content-Type": "application/xml" } },
        ),
      ).resolves.toMatchObject({ status: 415, data: media.json() });
      await expect(postApiDataManagerTransitSync(oversizedBody, { client })).resolves.toMatchObject(
        { status: 413, data: oversized.json() },
      );
      expect(calls).toBe(0);
    } finally {
      await app.close();
      await baseline.close();
    }
  });
  it("validates before database work and accepts a real typed conflict", async () => {
    const app = Fastify();
    let calls = 0;
    registerDataManagerAdminRoute(app, "postApiDataManagerTransitSync", async (_req, reply) => {
      calls++;
      return reply.code(409).send({ ok: false, reason: "in-flight", existingJobId: null });
    });
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/data-manager/transit/sync",
            payload: { countries: "de" },
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toBe(0);
      const response = await app.inject({
        method: "POST",
        url: "/data-manager/transit/sync",
        payload: { countries: ["de"] },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ ok: false, reason: "in-flight", existingJobId: null });
    } finally {
      await app.close();
    }
  });
});

describe("shared registration response kinds and ordering", () => {
  it("preserves legacy preValidation/beforeValidation/preHandler sequencing", async () => {
    const app = Fastify();
    const calls: string[] = [];
    app.addHook("preHandler", async () => {
      calls.push("inherited guard");
    });
    registerDataManagerAdminRoute(
      app,
      "postApiDataManagerTransitSync",
      async (_req, reply) => {
        calls.push("handler");
        return reply.code(202).send({ ok: true, jobId: "job", status: "started" });
      },
      {
        beforeValidation: async () => {
          calls.push("before validation");
        },
        preHandler: (_req, _reply, done) => {
          calls.push("route guard");
          done();
        },
      },
    );
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/data-manager/transit/sync",
            payload: { countries: "bad" },
          })
        ).statusCode,
      ).toBe(400);
      expect(calls).toEqual(["before validation"]);
      calls.length = 0;
      expect(
        (await app.inject({ method: "POST", url: "/data-manager/transit/sync", payload: {} }))
          .statusCode,
      ).toBe(202);
      expect(calls).toEqual(["before validation", "inherited guard", "route guard", "handler"]);
    } finally {
      await app.close();
    }
  });
  it("emits and qualifies explicit text, empty and raw stream responses", async () => {
    const { createAdminRouteRegistrar } = await import("../admin-contract");
    const { adminCommonResponses, adminText, adminEmpty, adminStream } = await import(
      "@openmapx/core/api-contracts"
    );
    const { z } = await import("zod/v4");
    const register = createAdminRouteRegistrar(
      {
        text: {
          method: "GET",
          path: "/api/text",
          auth: "admin",
          responses: { ...adminCommonResponses, 200: adminText(z.literal("hello")) },
        },
        empty: {
          method: "GET",
          path: "/api/empty",
          auth: "admin",
          responses: { ...adminCommonResponses, 204: adminEmpty() },
        },
        stream: {
          method: "GET",
          path: "/api/stream",
          auth: "admin",
          responses: { ...adminCommonResponses, 200: adminStream("text/event-stream") },
        },
      },
      { tag: "fixture", validationPhase: "preHandler" },
    );
    const app = Fastify();
    const schemas: Record<string, unknown> = {};
    app.addHook("onRoute", (route) => {
      if (route.method !== "HEAD") schemas[route.url] = route.schema?.response;
    });
    register(app, "text", async (_req, reply) => reply.type("text/plain").send("hello"));
    register(app, "empty", async (_req, reply) => reply.code(204).send());
    register(app, "stream", async (_req, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream" });
      reply.raw.end("event: fixture\ndata: {}\n\n");
      return reply;
    });
    try {
      const text = await app.inject("/text");
      expect(text.statusCode).toBe(200);
      expect(text.body).toBe("hello");
      const empty = await app.inject("/empty");
      expect(empty.statusCode).toBe(204);
      expect(empty.body).toBe("");
      const stream = await app.inject("/stream");
      expect(stream.statusCode).toBe(200);
      expect(stream.body).toContain("event: fixture");
      expect(schemas["/text"]).toMatchObject({
        200: { content: { "text/plain": { schema: { type: "string" } } } },
      });
      expect(schemas["/empty"]).toMatchObject({ 204: { description: "Response" } });
      expect(schemas["/empty"]).not.toHaveProperty("204.content");
      expect(schemas["/stream"]).toMatchObject({
        200: { content: { "text/event-stream": { schema: { type: "string" } } } },
      });
    } finally {
      await app.close();
    }
  });
});
