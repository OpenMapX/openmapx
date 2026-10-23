import * as sdk from "@openmapx/core/data-manager-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuth, resolveAuthToken } from "../src/auth.js";
import { registerDataManagerRoute } from "../src/route-contract.js";

const TOKEN = "test-secret-token";

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerAuth(app, TOKEN);
  // A protected route plus the health routes the hook must let through.
  app.get("/protected", async () => ({ ok: true }));
  app.get("/live", async () => ({ ok: true }));
  app.get("/status", async () => ({ ok: true }));
  app.get("/internal/transit/operator-feed/:handle", async () => ({ ok: true }));
  await app.ready();
  return app;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerAuth", () => {
  it("shares the failed-auth budget across addresses in the same IPv6 client prefix", async () => {
    const app = Fastify();
    registerAuth(app, TOKEN);
    app.get("/protected", async () => ({ ok: true }));
    try {
      for (let index = 1; index <= 20; index++) {
        const response = await app.inject({
          method: "GET",
          url: "/protected",
          remoteAddress: `2001:db8:1:2::${index.toString(16)}`,
        });
        expect(response.statusCode).toBe(401);
      }
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/protected",
            remoteAddress: "2001:db8:1:2::ff",
          })
        ).statusCode,
      ).toBe(429);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/protected",
            remoteAddress: "2001:db8:1:3::1",
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
  it("preserves actual JSON and bodyless HEAD throttling through the generated SDK", async () => {
    const app = Fastify({ exposeHeadRoutes: false });
    registerAuth(app, TOKEN);
    const unexpected = () => {
      throw new Error("Invalid credentials reached a handler");
    };
    registerDataManagerRoute(app, "getDatasets", unexpected);
    registerDataManagerRoute(app, "headOfflineGlyph", unexpected);
    registerDataManagerRoute(app, "headOfflinePackageArchive", unexpected);
    registerDataManagerRoute(app, "prepareOfflinePackage", unexpected);
    const transport = sdk.createDataManagerTransport({
      baseUrl: "https://data-manager.test",
      authToken: "wrong",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const response = await app.inject({
          method: init?.method as "GET" | "POST" | "HEAD",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers)),
          payload: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(init?.method === "HEAD" ? null : response.body, {
          status: response.statusCode,
          headers: Object.fromEntries(
            Object.entries(response.headers)
              .filter(([, value]) => value !== undefined)
              .map(([name, value]) => [name, String(value)]),
          ),
        });
      },
    });
    try {
      for (let i = 0; i < 20; i++) expect((await sdk.getDatasets({ transport })).status).toBe(401);
      const response = await sdk.getDatasets({ transport });
      expect(response).toMatchObject({
        status: 429,
        data: { error: "Too many authentication attempts" },
      });
      expect(response.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      for (const head of [
        sdk.headOfflineGlyph("v1", "Noto", "0-255", { transport }),
        sdk.headOfflinePackageArchive(`omp2-${"a".repeat(64)}`, undefined, { transport }),
      ]) {
        const result = await head;
        expect(result).toMatchObject({ status: 429, data: undefined });
        expect(result.headers.get("retry-after")).toMatch(/^[1-9]\d*$/);
      }
      expect(
        await sdk.prepareOfflinePackage(
          {
            bbox: { west: 1, south: 1, east: 2, north: 2 },
            minZoom: 1,
            maxZoom: 2,
            provider: "openmapx",
          },
          { "x-offline-package-principal": "a".repeat(64) },
          { transport },
        ),
      ).toMatchObject({ status: 429, data: { error: "Too many authentication attempts" } });
    } finally {
      await app.close();
    }
  });

  it("bounds failed authentication before body parsing while preserving authorized jobs, probes and relay capabilities", async () => {
    const app = Fastify({ bodyLimit: 16 });
    registerAuth(app, TOKEN);
    app.post("/protected", async () => ({ ok: true }));
    app.get("/live", async () => ({ ok: true }));
    app.get("/status", async () => ({ ok: true }));
    app.get("/internal/transit/operator-feed/:handle", async () => ({ ok: true }));
    try {
      const failures = [];
      for (let i = 0; i < 21; i++)
        failures.push(
          await app.inject({
            method: "POST",
            url: "/protected",
            headers: { "content-type": "application/json" },
            payload: "not json",
          }),
        );
      expect(failures.slice(0, 20).every((res) => res.statusCode === 401)).toBe(true);
      expect(failures[20]?.statusCode).toBe(429);
      expect(failures[20]?.json()).toEqual({ error: "Too many authentication attempts" });
      expect(Number(failures[20]?.headers["retry-after"])).toBeGreaterThan(0);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/protected",
            headers: { "x-forwarded-for": "192.0.2.99" },
          })
        ).statusCode,
      ).toBe(429);
      for (let i = 0; i < 25; i++) {
        expect(
          (
            await app.inject({
              method: "POST",
              url: "/protected",
              headers: { authorization: `Bearer ${TOKEN}` },
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
        expect((await app.inject("/live")).statusCode).toBe(200);
        expect((await app.inject("/status")).statusCode).toBe(200);
        expect(
          (await app.inject(`/internal/transit/operator-feed/${"a".repeat(64)}`)).statusCode,
        ).toBe(200);
      }
      expect(
        (await app.inject({ method: "POST", url: "/protected", remoteAddress: "192.0.2.2" }))
          .statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects a protected request with no token (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/protected" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a wrong token (401)", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("accepts the correct Bearer token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("accepts the correct x-data-manager-token header", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/protected",
      headers: { "x-data-manager-token": TOKEN },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets /status through without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets /live through without a token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/live" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("lets only a well-formed one-use relay GET capability through without the bearer token", async () => {
    const app = await buildApp();
    const handle = "a".repeat(64);
    const allowed = await app.inject({
      method: "GET",
      url: `/internal/transit/operator-feed/${handle}`,
    });
    const malformed = await app.inject({
      method: "GET",
      url: "/internal/transit/operator-feed/not-a-capability",
    });
    const wrongMethod = await app.inject({
      method: "POST",
      url: `/internal/transit/operator-feed/${handle}`,
    });

    expect(allowed.statusCode).toBe(200);
    expect(malformed.statusCode).toBe(401);
    expect(wrongMethod.statusCode).toBe(401);
    await app.close();
  });

  it("lets /status through even with a query string", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/status?probe=1" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("resolveAuthToken", () => {
  const stubApp = () => ({ log: { error: vi.fn(), warn: vi.fn() } }) as unknown as FastifyInstance;

  it("returns the configured token (trimmed)", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "  configured-token  ");
    expect(resolveAuthToken(stubApp())).toBe("configured-token");
  });

  it("throws in production when unset", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveAuthToken(stubApp())).toThrow(/required in production/i);
  });

  it("rejects a weak configured token in production", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "short");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => resolveAuthToken(stubApp())).toThrow(/DATA_MANAGER_AUTH_TOKEN.*too-short.*32/);
  });

  it("accepts a strong configured token in production", () => {
    const token = "x".repeat(32);
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", token);
    vi.stubEnv("NODE_ENV", "production");
    expect(resolveAuthToken(stubApp())).toBe(token);
  });

  it("generates a 64-hex ephemeral token in non-production when unset", () => {
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "");
    vi.stubEnv("NODE_ENV", "development");
    const token = resolveAuthToken(stubApp());
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

it("retains the durable-receiver prerequisite for internal control headers", async () => {
  const app = await buildApp();
  try {
    for (const name of ["x-openmapx-control-delegation", "x-openmapx-parent-execution"]) {
      for (const value of ["", "not-yet-admitted"]) {
        const response = await app.inject({
          url: "/protected",
          headers: { authorization: `Bearer ${TOKEN}`, [name]: value },
        });
        expect(response.statusCode).toBe(503);
      }
      expect(
        (
          await app.inject({
            url: "/protected",
            headers: { authorization: `Bearer ${TOKEN}`, [name]: "x".repeat(4097) },
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (await app.inject({ url: "/protected", headers: { authorization: `Bearer ${TOKEN}` } }))
        .statusCode,
    ).toBe(200);
  } finally {
    await app.close();
  }
});
