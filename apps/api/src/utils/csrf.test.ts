import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import cors from "@fastify/cors";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authRoute } from "../routes/auth.js";
import { corsOptions } from "../server-wiring.js";
import {
  configuredTrustedWebOrigins,
  isBetterAuthCsrfPath,
  makeCsrfGuardHook,
  normalizeHttpOrigin,
  parseTrustedWebOrigins,
} from "./csrf.js";

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));
vi.mock("../auth.js", () => ({
  auth: { api: { getSession: mockGetSession } },
}));

const { requireAdmin } = await import("./require-admin.js");

const TRUSTED_ORIGIN = "https://web.example.test";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("OPENMAPX_LOCAL_ADMIN_TOKEN", "");
  vi.stubEnv("OPENMAPX_DISABLE_LOCALHOST_AUTH", "");
  mockGetSession.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("normalizeHttpOrigin", () => {
  it.each([
    ["http://example.test", "http://example.test"],
    ["HTTP://EXAMPLE.TEST", "http://example.test"],
    ["http://example.test:80", "http://example.test"],
    ["https://example.test:443", "https://example.test"],
    ["https://EXAMPLE.TEST:8443", "https://example.test:8443"],
    ["https://[2001:db8::1]:443", "https://[2001:db8::1]"],
  ])("normalizes the exact HTTP(S) origin %s", (input, expected) => {
    expect(normalizeHttpOrigin(input)).toBe(expected);
  });

  it.each([
    "",
    "null",
    "https://",
    "https://example.test/",
    "https://example.test/path",
    "https://example.test?query=1",
    "https://example.test#fragment",
    "https://user@example.test",
    "https://user:password@example.test",
    "ftp://example.test",
    "openmapx://",
    "https://*.example.test",
    "https://example.test:",
    " https://example.test",
    "https://example.test ",
    "https://exam\tple.test",
    "https://%65xample.test",
    "https://example.test,https://evil.test",
  ])("rejects the non-origin serialization %s", (input) => {
    expect(normalizeHttpOrigin(input)).toBeNull();
  });
});

describe("trusted web-origin configuration", () => {
  it("normalizes default ports and removes duplicate exact origins", () => {
    expect(
      parseTrustedWebOrigins(
        "HTTPS://WEB.EXAMPLE.TEST:443, https://web.example.test, http://localhost:3000",
      ),
    ).toEqual(["https://web.example.test", "http://localhost:3000"]);
  });

  it.each([
    "https://*.example.test",
    "https://example.test/path",
    "https://example.test,",
    ",https://example.test",
    "https://example.test,,https://second.test",
    "openmapx://",
  ])("fails closed on an unsafe web-origin configuration", (configured) => {
    const secretOrigin = `${configured}allowlist-secret-sentinel`;
    expect(() => parseTrustedWebOrigins(secretOrigin)).toThrow(
      "CORS_ORIGIN must contain only exact HTTP(S) origins",
    );
    try {
      parseTrustedWebOrigins(secretOrigin);
    } catch (error) {
      expect(String(error)).not.toContain("allowlist-secret-sentinel");
    }
  });

  it("reads the same normalized explicit web origins from CORS_ORIGIN", () => {
    vi.stubEnv("CORS_ORIGIN", "HTTPS://WEB.EXAMPLE.TEST:443, http://localhost:3000");
    expect(configuredTrustedWebOrigins()).toEqual([
      "https://web.example.test",
      "http://localhost:3000",
    ]);
  });
});

describe("Better Auth CSRF path boundary", () => {
  it.each(["/api/auth", "/api/auth/", "/api/auth/sign-out", "/api/auth/sign-out?next=1"])(
    "excludes only the real Better Auth pathname %s",
    (url) => {
      expect(isBetterAuthCsrfPath(url)).toBe(true);
    },
  );

  it.each([
    "/api/authentic",
    "/api/authz/sign-out",
    "/api/%61uth/sign-out",
    "/api/auth%2fsign-out",
    "/api/auth/%2e%2e/admin",
    "/api/auth/../admin",
    String.raw`/api/auth\sign-out`,
    "https://web.example.test/api/auth/sign-out",
  ])("does not exempt an encoded or lookalike pathname %s", (url) => {
    expect(isBetterAuthCsrfPath(url)).toBe(false);
  });
});

interface GuardApp {
  app: FastifyInstance;
  handlerCalls: ReturnType<typeof vi.fn>;
  parserCalls: ReturnType<typeof vi.fn>;
}

async function buildGuardApp(
  options: { loggerInstance?: FastifyBaseLogger; registerCors?: boolean } = {},
): Promise<GuardApp> {
  const app = options.loggerInstance
    ? Fastify({ loggerInstance: options.loggerInstance })
    : Fastify({ logger: false });
  if (options.registerCors) {
    await app.register(cors, corsOptions([TRUSTED_ORIGIN]));
  }
  const parserCalls = vi.fn();
  app.addContentTypeParser(
    "application/x-csrf-test",
    { parseAs: "string" },
    (_request, body, done) => {
      parserCalls(body);
      done(null, body);
    },
  );
  app.addHook("onRequest", makeCsrfGuardHook([TRUSTED_ORIGIN]));
  const handlerCalls = vi.fn(async () => ({ ok: true }));
  app.all("/application", handlerCalls);
  app.all("/api/authentic", handlerCalls);
  await app.ready();
  return { app, handlerCalls, parserCalls };
}

describe("application CSRF guard", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "allows a trusted exact-origin cookie %s",
    async (method) => {
      const { app, handlerCalls } = await buildGuardApp();
      const response = await app.inject({
        method,
        url: "/application",
        headers: { cookie: "session=fixture", origin: TRUSTED_ORIGIN },
      });
      expect(response.statusCode).toBe(200);
      expect(handlerCalls).toHaveBeenCalledOnce();
      await app.close();
    },
  );

  it("matches scheme, normalized hostname, and effective port exactly", async () => {
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeCsrfGuardHook(["https://EXAMPLE.TEST:443"]));
    app.post("/application", async () => ({ ok: true }));
    const accepted = await app.inject({
      method: "POST",
      url: "/application",
      headers: { cookie: "session=fixture", origin: "https://example.test" },
    });
    const wrongScheme = await app.inject({
      method: "POST",
      url: "/application",
      headers: { cookie: "session=fixture", origin: "http://example.test" },
    });
    const wrongPort = await app.inject({
      method: "POST",
      url: "/application",
      headers: { cookie: "session=fixture", origin: "https://example.test:444" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(wrongScheme.statusCode).toBe(403);
    expect(wrongPort.statusCode).toBe(403);
    await app.close();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "allows cookie-free bearer/service/anonymous %s authentication to continue",
    async (method) => {
      const { app, handlerCalls } = await buildGuardApp();
      const bearer = await app.inject({
        method,
        url: "/application",
        headers: { authorization: "Bearer service-token-sentinel" },
      });
      const anonymous = await app.inject({ method, url: "/application" });
      expect(bearer.statusCode).toBe(200);
      expect(anonymous.statusCode).toBe(200);
      expect(handlerCalls).toHaveBeenCalledTimes(2);
      await app.close();
    },
  );

  it.each(["GET", "HEAD", "OPTIONS"] as const)(
    "leaves cookie-bearing safe method %s unaffected",
    async (method) => {
      const { app, handlerCalls } = await buildGuardApp();
      const response = await app.inject({
        method,
        url: "/application",
        headers: { cookie: "session=fixture" },
      });
      expect(response.statusCode).toBe(200);
      expect(handlerCalls).toHaveBeenCalledOnce();
      await app.close();
    },
  );

  it.each([
    undefined,
    "null",
    "https://sibling.example.test",
    "https://web.example.test.evil.test",
    "https://evil.test",
    "http://web.example.test",
    "https://web.example.test:444",
    "https://web.example.test/",
    "https://web.example.test/path",
    "https://user@web.example.test",
    "ftp://web.example.test",
    "https://*.example.test",
    "https://web.example.test, https://web.example.test",
  ])("rejects a cookie mutation with unsafe Origin %s before its handler", async (origin) => {
    const { app, handlerCalls } = await buildGuardApp();
    const response = await app.inject({
      method: "POST",
      url: "/application",
      headers: {
        cookie: "session=cookie-secret-sentinel",
        ...(origin === undefined ? {} : { origin }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    expect(handlerCalls).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([{ cookie: "" }, { cookie: ["first=1", "second=2"] }])(
    "treats empty and multiple raw Cookie forms as cookie-bearing",
    async (headers) => {
      const { app, handlerCalls } = await buildGuardApp();
      const response = await app.inject({
        method: "POST",
        url: "/application",
        headers: headers as never,
      });
      expect(response.statusCode).toBe(403);
      expect(handlerCalls).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("rejects multiple raw Origin headers even when every value is trusted", async () => {
    const { app, handlerCalls } = await buildGuardApp();
    const response = await app.inject({
      method: "POST",
      url: "/application",
      headers: {
        cookie: "session=fixture",
        origin: [TRUSTED_ORIGIN, TRUSTED_ORIGIN],
      } as never,
    });
    expect(response.statusCode).toBe(403);
    expect(handlerCalls).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects before body parsing and reveals no policy or request secrets", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const loggerInstance = pino({ level: "info" }, stream);
    const { app, handlerCalls, parserCalls } = await buildGuardApp({ loggerInstance });
    const response = await app.inject({
      method: "POST",
      url: "/application",
      headers: {
        cookie: "session=cookie-secret-sentinel",
        origin: "https://attacker-origin-sentinel.test",
        "content-type": "application/x-csrf-test",
      },
      payload: "submitted-body-secret-sentinel",
    });
    await app.close();

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    expect(parserCalls).not.toHaveBeenCalled();
    expect(handlerCalls).not.toHaveBeenCalled();
    const observable = `${response.payload}\n${chunks.join("")}`;
    expect(observable).not.toMatch(
      /web\.example\.test|cookie-secret-sentinel|submitted-body-secret-sentinel|attacker-origin-sentinel|session/i,
    );
  });

  it("does not exempt an application path that merely begins with /api/auth", async () => {
    const { app, handlerCalls } = await buildGuardApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/authentic",
      headers: { cookie: "session=fixture" },
    });
    expect(response.statusCode).toBe(403);
    expect(handlerCalls).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("Better Auth exemption integration", () => {
  it.each(["sign-out", "sign-in/email", "sign-up/email", "change-password"])(
    "leaves unsafe cookie POST /api/auth/%s to Better Auth's own origin middleware",
    async (endpoint) => {
      const database: Record<string, Array<Record<string, unknown>>> = {
        user: [],
        session: [],
        account: [],
        verification: [],
      };
      const testAuth = betterAuth({
        database: memoryAdapter(database),
        baseURL: "http://localhost:3001",
        secret: "csrf-integration-secret-at-least-thirty-two-characters",
        trustedOrigins: parseTrustedWebOrigins(TRUSTED_ORIGIN),
        // Better Auth snapshots NODE_ENV when Vitest imports it and otherwise
        // disables origin checks in tests. Force the production setting here.
        advanced: { disableOriginCheck: false },
        emailAndPassword: { enabled: true },
      });
      const app = Fastify({ logger: false });
      app.addHook("onRequest", makeCsrfGuardHook([TRUSTED_ORIGIN]));
      await app.register(authRoute, {
        authHandler: testAuth.handler,
        authUiOrigin: TRUSTED_ORIGIN,
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/auth/${endpoint}`,
        headers: {
          host: "localhost:3001",
          cookie: "better-auth.session_token=fake-cookie",
          "content-type": "application/json",
        },
        payload: {},
      });
      await app.close();

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "MISSING_OR_NULL_ORIGIN",
        message: "Missing or null Origin",
      });
      expect(response.json()).not.toEqual({ error: "Forbidden" });
    },
  );
});

describe("production hook wiring", () => {
  it("installs CSRF after response security and before rate limiting and routes", () => {
    const serverSource = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
    const securityHook = serverSource.indexOf(
      'server.addHook("onRequest", makeSecurityResponseHeaderHook())',
    );
    const csrfHook = serverSource.indexOf(
      'server.addHook("onRequest", makeCsrfGuardHook(trustedWebOrigins))',
    );
    const rateLimitHook = serverSource.indexOf(
      'server.addHook(\n  "onRequest",\n  makeRateLimitTierHook',
    );
    const coreRoutes = serverSource.indexOf("await registerCoreRoutes(server");

    expect(securityHook).toBeGreaterThan(-1);
    expect(csrfHook).toBeGreaterThan(securityHook);
    expect(rateLimitHook).toBeGreaterThan(csrfHook);
    expect(coreRoutes).toBeGreaterThan(rateLimitHook);
  });
});

describe("independent local-admin boundary", () => {
  it("still requires the loopback custom header even when CSRF origin validation passes", async () => {
    mockGetSession.mockResolvedValue(null);
    const app = Fastify({ logger: false });
    app.addHook("onRequest", makeCsrfGuardHook([TRUSTED_ORIGIN]));
    app.post("/api/admin/mutate", async (request) => {
      const session = await requireAdmin(request);
      return { userId: session.user.id };
    });

    const withoutLocalHeader = await app.inject({
      method: "POST",
      url: "/api/admin/mutate",
      headers: { cookie: "session=fixture", origin: TRUSTED_ORIGIN },
    });
    const withLocalHeader = await app.inject({
      method: "POST",
      url: "/api/admin/mutate",
      headers: {
        cookie: "session=fixture",
        origin: TRUSTED_ORIGIN,
        "x-openmapx-local-admin": "",
      },
    });
    await app.close();

    expect(withoutLocalHeader.statusCode).toBe(401);
    expect(withLocalHeader.statusCode).toBe(200);
    expect(withLocalHeader.json()).toEqual({ userId: "loopback" });
  });
});

describe("dynamic CORS alignment", () => {
  it("varies on Origin and never reflects an untrusted origin", async () => {
    const { app } = await buildGuardApp({ registerCors: true });
    const trusted = await app.inject({
      method: "GET",
      url: "/application",
      headers: { origin: TRUSTED_ORIGIN },
    });
    const untrusted = await app.inject({
      method: "GET",
      url: "/application",
      headers: { origin: "https://evil.example.test" },
    });
    await app.close();

    expect(trusted.headers["access-control-allow-origin"]).toBe(TRUSTED_ORIGIN);
    expect(trusted.headers.vary).toMatch(/(?:^|,\s*)Origin(?:,|$)/i);
    expect(untrusted.headers["access-control-allow-origin"]).toBeUndefined();
    expect(untrusted.headers.vary).toMatch(/(?:^|,\s*)Origin(?:,|$)/i);
  });
});
