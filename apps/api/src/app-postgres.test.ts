import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "./app";
import { createMigratedPostgresFixture } from "./test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

const TRUSTED_ORIGIN = "https://web.example.test";
const PUBLIC_RATE_LIMIT = 3;
const CLOSED_LOCAL_URL = "http://127.0.0.1:9";
const PROBE_PATH = "/api/hook-order-probe";
const PROCESS_LIFECYCLE_EVENTS = new Set([
  "uncaughtException",
  "unhandledRejection",
  "SIGTERM",
  "SIGINT",
]);

type IntervalHandle = ReturnType<typeof setInterval>;

function calledFromApiSource(): boolean {
  return (new Error().stack ?? "")
    .split("\n")
    .some((frame) => frame.includes("/apps/api/src/") && !frame.includes("app-postgres.test"));
}

describeDatabase("the real application from createApp()", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realProcessOn = process.on.bind(process);
  const intervals: IntervalHandle[] = [];
  const clearedIntervals = new Set<unknown>();
  const processHandlers: string[] = [];
  const originalStackTraceLimit = Error.stackTraceLimit;
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let customIntegrations: string;
  let app: App;
  let intervalsAfterImport: number;
  let probeCalls = 0;

  beforeAll(async () => {
    Error.stackTraceLimit = 40;
    // The fixture is built before the spies so its own client is not counted.
    fixture = await createMigratedPostgresFixture();
    customIntegrations = await mkdtemp(join(tmpdir(), "openmapx-app-integrations-"));
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("DATABASE_URL", fixture.connectionUri);
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-with-enough-length-for-auth-0123456789");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", "ab".repeat(32));
    vi.stubEnv("CORS_ORIGIN", TRUSTED_ORIGIN);
    vi.stubEnv("OSM_API_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_WEB_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_DISCOVERY_URL", `${CLOSED_LOCAL_URL}/.well-known/openid-configuration`);
    vi.stubEnv("OPENMAPX_CUSTOM_INTEGRATIONS_DIR", customIntegrations);
    vi.stubEnv("RATE_LIMIT_PUBLIC_MAX", String(PUBLIC_RATE_LIMIT));

    vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      if (calledFromApiSource()) intervals.push(handle);
      return handle;
    }) as typeof setInterval);
    vi.stubGlobal("clearInterval", ((handle: IntervalHandle | undefined) => {
      clearedIntervals.add(handle);
      realClearInterval(handle);
    }) as typeof clearInterval);
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (PROCESS_LIFECYCLE_EVENTS.has(event)) processHandlers.push(event);
      return realProcessOn(event as "exit", listener);
    }) as typeof process.on);

    const { createApp } = await import("./app");
    intervalsAfterImport = intervals.length;
    app = await createApp();
    app.server.post(PROBE_PATH, async () => {
      probeCalls += 1;
      return { reached: true };
    });
    await app.server.ready();
  }, 240_000);

  afterAll(async () => {
    try {
      await app?.stop();
      const { sql } = await import("./db/index");
      await sql.end({ timeout: 5 });
    } finally {
      Error.stackTraceLimit = originalStackTraceLimit;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(customIntegrations, { recursive: true, force: true });
      await fixture?.stop();
    }
  }, 60_000);

  function postProbe(remoteAddress: string, origin?: string) {
    return app.server.inject({
      method: "POST",
      url: PROBE_PATH,
      remoteAddress,
      headers: { cookie: "session=fixture", ...(origin ? { origin } : {}) },
    });
  }

  it("does not start anything when imported or built", () => {
    expect(intervalsAfterImport).toBe(0);
    expect(processHandlers).toEqual([]);
    expect(app.server.server.listening).toBe(false);
  });

  it("serves a real core route through the registered hooks", async () => {
    const response = await app.server.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends security headers on a request that CSRF rejects", async () => {
    const response = await app.server.inject({
      method: "POST",
      url: "/api/mobile-auth/issue",
      remoteAddress: "203.0.113.10",
      headers: { cookie: "session=fixture", origin: "https://attacker.example.test" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Forbidden" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("rejects CSRF failures before they reach the rate limiter or the route", async () => {
    const remoteAddress = "203.0.113.20";
    probeCalls = 0;

    for (let attempt = 0; attempt < PUBLIC_RATE_LIMIT + 2; attempt += 1) {
      const response = await postProbe(remoteAddress);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: "Forbidden" });
    }
    expect(probeCalls).toBe(0);

    for (let attempt = 0; attempt < PUBLIC_RATE_LIMIT; attempt += 1) {
      const response = await postProbe(remoteAddress, TRUSTED_ORIGIN);
      expect(response.statusCode).toBe(200);
    }
    expect(probeCalls).toBe(PUBLIC_RATE_LIMIT);

    const limited = await postProbe(remoteAddress, TRUSTED_ORIGIN);
    expect(limited.statusCode).toBe(429);
    expect(probeCalls).toBe(PUBLIC_RATE_LIMIT);
  });

  // Runs last: stop() closes the server every other case injects into.
  it("stops cleanly after a start that could not bind its port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Blocker has no port");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("PORT", String(address.port));
    const firstStartInterval = intervals.length;

    try {
      await expect(app.start()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    await app.stop();
    await expect(app.stop()).resolves.toBeUndefined();

    const startedIntervals = intervals.slice(firstStartInterval);
    expect(startedIntervals.length).toBeGreaterThan(0);
    expect(startedIntervals.filter((handle) => !clearedIntervals.has(handle))).toEqual([]);
  }, 60_000);
});
