import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataManagerOperations } from "@openmapx/core/data-manager-contracts";
import * as sdk from "@openmapx/core/data-manager-sdk";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAuth, requestPrincipal, resolveCallerTokens } from "../src/auth.js";
import {
  DATA_MANAGER_PRINCIPALS,
  DATA_MANAGER_ROUTE_PRINCIPALS,
  type DataManagerPrincipal,
} from "../src/principals.js";
import { registerDataManagerRoute } from "../src/route-contract.js";

const TOKEN = "test-secret-token";
const TOKENS = { api: TOKEN, "ops-agent": "agent-secret-token", "host-cli": "cli-secret-token" };
/** A plain route every caller may use, for the hook's generic behaviour. */
const everyone = {
  schema: { "x-openmapx-principals": [...DATA_MANAGER_PRINCIPALS] } as Record<string, unknown>,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  registerAuth(app, TOKENS);
  // A protected route plus the health routes the hook must let through.
  app.get("/protected", everyone, async () => ({ ok: true }));
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
    registerAuth(app, TOKENS);
    app.get("/protected", everyone, async () => ({ ok: true }));
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
    registerAuth(app, TOKENS);
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
    registerAuth(app, TOKENS);
    app.post("/protected", everyone, async () => ({ ok: true }));
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

describe("resolveCallerTokens", () => {
  const stubApp = () => ({ log: { error: vi.fn(), warn: vi.fn() } }) as unknown as FastifyInstance;
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });
  function tokenFiles(values: Record<DataManagerPrincipal, string>) {
    const directory = mkdtempSync(join(tmpdir(), "openmapx-dm-tokens-"));
    directories.push(directory);
    const env: Record<string, string> = {};
    const names = {
      api: "DATA_MANAGER_API_TOKEN_FILE",
      "ops-agent": "DATA_MANAGER_OPS_AGENT_TOKEN_FILE",
      "host-cli": "DATA_MANAGER_HOST_CLI_TOKEN_FILE",
    } as const;
    for (const principal of DATA_MANAGER_PRINCIPALS) {
      const path = join(directory, principal);
      writeFileSync(path, values[principal], { mode: 0o600 });
      env[names[principal]] = path;
    }
    return env;
  }
  const strong = { api: "a".repeat(43), "ops-agent": "b".repeat(43), "host-cli": "c".repeat(43) };

  it("reads each caller's token from its own file", () => {
    expect(
      resolveCallerTokens(stubApp(), { NODE_ENV: "production", ...tokenFiles(strong) }),
    ).toEqual(strong);
  });

  it("requires every token file in production", () => {
    const env: Record<string, string> = { NODE_ENV: "production", ...tokenFiles(strong) };
    delete env.DATA_MANAGER_HOST_CLI_TOKEN_FILE;
    expect(() => resolveCallerTokens(stubApp(), env)).toThrow(
      /DATA_MANAGER_HOST_CLI_TOKEN_FILE is required in production/,
    );
  });

  it("rejects a weak token in production", () => {
    const env = { NODE_ENV: "production", ...tokenFiles({ ...strong, api: "short" }) };
    expect(() => resolveCallerTokens(stubApp(), env)).toThrow(
      /DATA_MANAGER_API_TOKEN_FILE.*too-short.*32/,
    );
  });

  it("refuses two callers sharing one token", () => {
    const env = tokenFiles({ ...strong, "host-cli": strong["ops-agent"] });
    expect(() => resolveCallerTokens(stubApp(), env)).toThrow(/its own token/);
    expect(() => registerAuth(Fastify(), { api: "x", "ops-agent": "x", "host-cli": "y" })).toThrow(
      /its own token/,
    );
  });

  it("gives an unconfigured caller an unknown random token in development", () => {
    const tokens = resolveCallerTokens(stubApp(), { NODE_ENV: "development" });
    for (const principal of DATA_MANAGER_PRINCIPALS)
      expect(tokens[principal]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("per-caller route allowlist", () => {
  async function contractApp() {
    const app = Fastify({ exposeHeadRoutes: false });
    registerAuth(app, TOKENS);
    const seen: Array<DataManagerPrincipal | undefined> = [];
    for (const operationId of Object.keys(dataManagerOperations) as Array<
      keyof typeof dataManagerOperations
    >)
      registerDataManagerRoute(app, operationId, async (request, reply) => {
        seen.push(requestPrincipal(request));
        return reply.code(418).send();
      });
    await app.ready();
    return { app, seen };
  }
  function concretePath(path: string) {
    return path
      .replace(":maintenanceId", "00000000-0000-4000-8000-000000000000")
      .replace(":operationKey", "opk1_abcdefghijklmnop")
      .replace(":handle", "a".repeat(64))
      .replace(/:[A-Za-z]+/g, "x");
  }

  it("admits each caller exactly to the routes listed for it", async () => {
    const { app } = await contractApp();
    try {
      for (const [operationId, operation] of Object.entries(dataManagerOperations)) {
        const allowed = DATA_MANAGER_ROUTE_PRINCIPALS[
          operationId as keyof typeof dataManagerOperations
        ] as readonly string[];
        if (operation.auth !== "service") {
          expect(allowed, operationId).toEqual([]);
          continue;
        }
        expect(allowed.length, operationId).toBeGreaterThan(0);
        for (const principal of DATA_MANAGER_PRINCIPALS) {
          const response = await app.inject({
            method: operation.method as "GET",
            url: concretePath(operation.path),
            headers: { authorization: `Bearer ${TOKENS[principal]}` },
          });
          if (allowed.includes(principal))
            expect(response.statusCode, `${principal} ${operationId}`).not.toBe(403);
          else {
            expect(response.statusCode, `${principal} ${operationId}`).toBe(403);
            if (operation.method !== "HEAD")
              expect(response.json(), `${principal} ${operationId}`).toEqual({
                error: "This caller may not use this route",
              });
          }
        }
      }
    } finally {
      await app.close();
    }
  });

  it("keeps the configuration fence to the operations agent", async () => {
    const { app } = await contractApp();
    try {
      for (const operationId of [
        "prepareDataConfigurationFence",
        "recoverUnadmittedConfigurationPreparation",
        "inspectDataConfigurationFence",
        "settleDataConfigurationFence",
      ] as const)
        expect(DATA_MANAGER_ROUTE_PRINCIPALS[operationId]).toEqual(["ops-agent"]);
      for (const [principal, status] of [
        ["api", 403],
        ["host-cli", 403],
        ["ops-agent", 400],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/executions/configuration-maintenance/prepare",
          headers: { authorization: `Bearer ${TOKENS[principal]}` },
          payload: {},
        });
        expect(response.statusCode, principal).toBe(status);
      }
    } finally {
      await app.close();
    }
  });

  it("tells the handler which caller the token belongs to", async () => {
    const { app, seen } = await contractApp();
    try {
      for (const principal of ["api", "ops-agent", "host-cli"] as const)
        await app.inject({
          method: "GET",
          url: "/datasets",
          headers: { "x-data-manager-token": TOKENS[principal] },
        });
      expect(seen).toEqual(["api", "ops-agent", "host-cli"]);
    } finally {
      await app.close();
    }
  });

  it("refuses an authenticated caller on a route without a caller list", async () => {
    const app = Fastify();
    registerAuth(app, TOKENS);
    app.get("/unlisted", async () => ({ ok: true }));
    try {
      const response = await app.inject({
        url: "/unlisted",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(403);
      const missing = await app.inject({
        url: "/missing",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
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
