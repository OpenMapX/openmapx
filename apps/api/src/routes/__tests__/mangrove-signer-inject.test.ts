import { generateKeyPairSync } from "node:crypto";
import { setup } from "@integrations/reviews-mangrove";
import {
  httpError,
  type LoadedIntegration,
  type UpstreamRuntime,
} from "@openmapx/integration-framework";
import {
  createMockIntegrationContext,
  createNoopLogger,
} from "@openmapx/integration-framework/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("../../utils/require-auth.js", () => ({ requireAuth: vi.fn() }));

import { createHttpClient } from "../../integration-clients.js";
import {
  registerIntegrationRoute,
  registerIntegrationRouteDispatcher,
  resetIntegrationRoutes,
  setIntegrationRouteRateLimits,
} from "../../integration-routes.js";
import { buildTestApp } from "../../test/app.js";
import { requireAuth } from "../../utils/require-auth.js";

const PEM = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString()
  .replace(/\n/g, "");
const ACCOUNT = { reviewer_id: "reviewer-1", public_key: PEM };
const PREFIX = "/api/integrations/reviews-mangrove/signer/";
const AUTH = { authorization: "Bearer test-owner" };

describe("Mangrove signer over the production dispatcher and host HTTP client", () => {
  let app: FastifyInstance;
  let fetchMock: ReturnType<typeof vi.fn>;
  let expensive: Mock<() => Promise<void>>;
  let log: ReturnType<typeof createNoopLogger>;
  beforeEach(async () => {
    resetIntegrationRoutes();
    vi.mocked(requireAuth).mockImplementation(async (request) => {
      if (request.headers.authorization !== AUTH.authorization)
        throw httpError(401, "Authentication required");
      return "owner";
    });
    expensive = vi.fn(async () => {});
    setIntegrationRouteRateLimits({
      public: vi.fn(async () => {}),
      expensive,
      tile: vi.fn(async () => {}),
    });
    fetchMock = vi.fn(async () => Response.json(ACCOUNT));
    vi.stubGlobal("fetch", fetchMock);
    log = createNoopLogger();
    vi.spyOn(log, "error");
    app = await buildTestApp(async (fastify: FastifyInstance) => {
      const ctx = createMockIntegrationContext({
        id: "reviews-mangrove",
        config: {
          signerClientId: "registered-client",
          signerRedirectUri: "https://maps.test/auth/mangrove",
        },
        http: createHttpClient(log),
        log,
      });
      Object.assign(ctx, {
        upstreamRuntime: {
          admitSharedRequest: async () => ({ allowed: true, remaining: null }),
        } as unknown as UpstreamRuntime,
      });
      ctx.registerRoute = (method, path, handler, options) =>
        registerIntegrationRoute(ctx.id, method, path, handler, options);
      setup(ctx);
      registerIntegrationRouteDispatcher(
        fastify,
        new Map([[ctx.id, { id: ctx.id, enabled: true } as LoadedIntegration]]),
      );
    });
  });
  afterEach(async () => {
    await app.close();
    resetIntegrationRoutes();
    setIntegrationRouteRateLimits(null);
    vi.unstubAllGlobals();
  });

  it.each(["config", "account", "sign", "revoke"])(
    "requires authentication before %s and uses the expensive tier",
    async (path) => {
      const response = await app.inject({
        method: path === "config" ? "GET" : "POST",
        url: `${PREFIX}${path}`,
        ...(path === "config" ? {} : { payload: { sessionToken: "fixture-token" } }),
      });
      expect(response.statusCode).toBe(401);
      expect(expensive).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("compares expectedUserId against the dispatcher-authenticated user", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}account`,
      headers: AUTH,
      payload: { sessionToken: "fixture-token", expectedUserId: "other" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns only public account fields without caching and sends JSON only to the fixed official URL", async () => {
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}account`,
      headers: AUTH,
      payload: { sessionToken: "fixture-token", expectedUserId: "owner" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ reviewerId: "reviewer-1", publicPem: PEM });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fetchMock.mock.calls[0]).toEqual([
      "https://signer.mangrove.reviews/account",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: '{"session_token":"fixture-token"}',
      }),
    ]);
    expect(log.error).not.toHaveBeenCalled();
  });

  it.each(["oversize", "invalid-json", "redirect", "exception"])(
    "redacts %s host HTTP failures without retry or logs",
    async (failure) => {
      fetchMock.mockImplementation(async () => {
        if (failure === "exception") throw new Error("fixture-token");
        if (failure === "redirect")
          return Response.redirect("https://elsewhere.test/fixture-token", 302);
        if (failure === "oversize")
          return new Response(`"${"x".repeat(131073)}"`, {
            headers: { "Content-Type": "application/json" },
          });
        return new Response("fixture-token", { headers: { "Content-Type": "application/json" } });
      });
      const response = await app.inject({
        method: "POST",
        url: `${PREFIX}account`,
        headers: AUTH,
        payload: { sessionToken: "fixture-token" },
      });
      expect(response.statusCode).toBe(failure === "redirect" ? 502 : 503);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.body).not.toContain("fixture-token");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it.each([401, 429])(
    "preserves an upstream text/plain %i without echoing its body",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("fixture-token", { status, headers: { "Content-Type": "text/plain" } }),
      );
      const response = await app.inject({
        method: "POST",
        url: `${PREFIX}account`,
        headers: AUTH,
        payload: { sessionToken: "fixture-token" },
      });
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("fixture-token");
      expect(response.headers["cache-control"]).toBe("no-store");
    },
  );

  it("discards a stalled upstream error stream before reading or exposing it", async () => {
    let discarded = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        discarded = true;
      },
    });
    fetchMock.mockResolvedValue(
      new Response(body, {
        status: 401,
        headers: { "Content-Type": "text/plain", "Content-Length": "999999999" },
      }),
    );
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}account`,
      headers: AUTH,
      payload: { sessionToken: "fixture-token" },
    });
    expect(response.statusCode).toBe(401);
    expect(discarded).toBe(true);
    expect(response.body).not.toContain("fixture-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("accepts upstream revoke's documented empty 204 response", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const response = await app.inject({
      method: "POST",
      url: `${PREFIX}revoke`,
      headers: AUTH,
      payload: { sessionToken: "fixture-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});
