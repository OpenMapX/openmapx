import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "./app";
import { createMigratedPostgresFixture } from "./test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

/** The lifecycle calls of createApp() and stop(), in the order they happened. */
const lifecycle = vi.hoisted(() => [] as string[]);

vi.mock("./integration-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./integration-host")>();
  return {
    ...actual,
    recoverInterruptedIntegrationTasks: () => {
      lifecycle.push("recover task runs");
      return actual.recoverInterruptedIntegrationTasks();
    },
    initIntegrations: (...args: Parameters<typeof actual.initIntegrations>) => {
      lifecycle.push("load integrations");
      return actual.initIntegrations(...args);
    },
    stopIntegrationTasks: () => {
      lifecycle.push("stop tasks");
      actual.stopIntegrationTasks();
    },
  };
});

vi.mock("./safe-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./safe-mode")>();
  return {
    ...actual,
    beginBoot: (...args: Parameters<typeof actual.beginBoot>) => {
      lifecycle.push("begin boot");
      return actual.beginBoot(...args);
    },
    markCleanStop: () => {
      lifecycle.push("mark clean stop");
      actual.markCleanStop();
    },
    initSafeMode: (...args: Parameters<typeof actual.initSafeMode>) => {
      lifecycle.push("read safe mode");
      return actual.initSafeMode(...args);
    },
    syncSafeModeAttention: () => {
      lifecycle.push("sync safe-mode attention");
      return actual.syncSafeModeAttention();
    },
  };
});

vi.mock("./extension-migrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extension-migrations")>();
  return {
    ...actual,
    cancelRunningExtensionMigrations: () => {
      lifecycle.push("cancel extension migrations");
      return actual.cancelRunningExtensionMigrations();
    },
  };
});

const TRUSTED_ORIGIN = "https://web.example.test";
const PUBLIC_RATE_LIMIT = 3;
const CLOSED_LOCAL_URL = "http://127.0.0.1:9";
const PROBE_PATH = "/api/hook-order-probe";
const ADMIN_PLATFORM_PATH = "/api/admin/platform/configuration";
const PROCESS_LIFECYCLE_EVENTS = new Set([
  "uncaughtException",
  "unhandledRejection",
  "SIGTERM",
  "SIGINT",
]);

// Refresh timers these integrations begin in setup(), which createApp() has to
// run. Their shutdown handlers release them, so none may survive stop().
const INTEGRATION_SETUP_TIMER_ORIGINS = [
  "packages/ourairports-data/loader.ts",
  "integrations/transit-dynamic-registry/registry.ts",
  "integrations/landmark-models/model-proxy.ts",
  // One catalogue refresh loop per Open Landmarks upstream (Barrelman and Open Landmarks).
  "packages/open-landmarks-client/client.ts",
  "packages/open-landmarks-client/client.ts",
];

interface TrackedTimer {
  kind: "interval" | "timeout";
  delay: number | undefined;
  origin: string;
  settled: boolean;
}

/**
 * The first application frame that created a timer, or null for library and
 * test timers. The database driver's idle timers belong to the pools, which
 * the server ends at shutdown rather than `stop()`.
 */
function applicationOrigin(): string | null {
  const frames = (new Error().stack ?? "").split("\n").slice(2);
  const creator = frames.find((line) => !line.includes("app-postgres.test"));
  if (creator?.includes("node_modules/postgres/")) return null;
  const frame = frames.find(
    (line) =>
      /\/(apps\/api\/src|integrations|packages)\//.test(line) &&
      !line.includes("node_modules") &&
      !line.includes("app-postgres.test"),
  );
  return frame ? frame.trim() : null;
}

describeDatabase("the real application from createApp()", () => {
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearInterval = globalThis.clearInterval;
  const realClearTimeout = globalThis.clearTimeout;
  const realProcessOn = process.on.bind(process);
  const timers = new Map<unknown, TrackedTimer>();
  const processHandlers: string[] = [];
  const originalStackTraceLimit = Error.stackTraceLimit;
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let customIntegrations: string;
  let runtimeDir: string;
  let app: App;
  let pendingAfterImport: TrackedTimer[];
  let pendingAfterCreateApp: TrackedTimer[];
  let probeCalls = 0;

  function pendingTimers(): TrackedTimer[] {
    return [...timers.values()].filter((timer) => !timer.settled);
  }

  function settleTimer(handle: unknown): void {
    const timer = timers.get(handle);
    if (timer) timer.settled = true;
  }

  beforeAll(async () => {
    Error.stackTraceLimit = 40;
    // The fixture is built before the spies so its own client is not counted.
    fixture = await createMigratedPostgresFixture();
    // A run a previous API process left behind.
    await fixture.sql`insert into integration_task_run (integration_id, task_name, status)
      values ('left-behind', 'nightly', 'running')`;
    // An integration that registered a subject-data handler and is gone now.
    await fixture.sql`insert into integration_subject_handler (integration_id)
      values ('not-installed')`;
    await fixture.sql`insert into subject_erasure_pending (integration_id, subject_user_id)
      values ('not-installed', 'deleted-account')`;
    customIntegrations = await mkdtemp(join(tmpdir(), "openmapx-app-integrations-"));
    // An installed integration whose code records that it ran, and an
    // operator's safe-mode file, so the start must keep that code out.
    const installedDemo = join(customIntegrations, "app-installed-demo");
    await mkdir(join(installedDemo, "dist", "backend"), { recursive: true });
    await writeFile(
      join(installedDemo, "manifest.json"),
      JSON.stringify({
        id: "app-installed-demo",
        name: "App Installed Demo",
        version: "1.0.0",
        platform: "1.0",
        license: "MIT",
        domains: ["knowledge"],
        quality: "community",
        backend: { entry: "dist/backend/index.mjs" },
      }),
    );
    await writeFile(
      join(installedDemo, "dist", "backend", "index.mjs"),
      "globalThis.__omxAppInstalledEvaluated = true;\nexport function setup() {}\n",
    );
    runtimeDir = await mkdtemp(join(tmpdir(), "openmapx-app-runtime-"));
    await writeFile(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');
    vi.stubEnv("OPENMAPX_API_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("OPENMAPX_SAFE_MODE", "");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("DATABASE_URL", fixture.connectionUri);
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-with-enough-length-for-auth-0123456789");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 0xab).toString("base64url"));
    vi.stubEnv("CORS_ORIGIN", TRUSTED_ORIGIN);
    vi.stubEnv("OSM_API_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_WEB_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_DISCOVERY_URL", `${CLOSED_LOCAL_URL}/.well-known/openid-configuration`);
    vi.stubEnv("OPENMAPX_CUSTOM_INTEGRATIONS_DIR", customIntegrations);
    vi.stubEnv("RATE_LIMIT_PUBLIC_MAX", String(PUBLIC_RATE_LIMIT));

    vi.stubGlobal("setInterval", ((...args: Parameters<typeof setInterval>) => {
      const handle = realSetInterval(...args);
      const origin = applicationOrigin();
      if (origin) {
        timers.set(handle, { kind: "interval", delay: args[1], origin, settled: false });
      }
      return handle;
    }) as typeof setInterval);
    vi.stubGlobal(
      "setTimeout",
      Object.assign(
        ((callback: (...values: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          const origin = applicationOrigin();
          if (!origin) return realSetTimeout(callback, delay, ...args);
          const timer: TrackedTimer = { kind: "timeout", delay, origin, settled: false };
          const handle = realSetTimeout(
            (...values: unknown[]) => {
              timer.settled = true;
              callback(...values);
            },
            delay,
            ...args,
          );
          timers.set(handle, timer);
          return handle;
        }) as typeof setTimeout,
        realSetTimeout,
      ),
    );
    vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
      settleTimer(handle);
      realClearInterval(handle);
    }) as typeof clearInterval);
    vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
      settleTimer(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout);
    vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) => {
      if (PROCESS_LIFECYCLE_EVENTS.has(event)) processHandlers.push(event);
      return realProcessOn(event as "exit", listener);
    }) as typeof process.on);

    const { createApp } = await import("./app");
    pendingAfterImport = pendingTimers();
    // Integration setup may request its upstreams; keep this suite off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("External network forbidden in the application fixture");
      }),
    );
    app = await createApp();
    pendingAfterCreateApp = pendingTimers();
    app.server.post(PROBE_PATH, async () => {
      probeCalls += 1;
      return { reached: true };
    });
    await app.server.ready();
  }, 240_000);

  afterAll(async () => {
    try {
      await app?.stop();
      const { extensionSql, integrationSql, sql } = await import("./db/index");
      await Promise.all([
        sql.end({ timeout: 5 }),
        integrationSql.end({ timeout: 5 }),
        extensionSql.end({ timeout: 5 }),
      ]);
    } finally {
      Error.stackTraceLimit = originalStackTraceLimit;
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(customIntegrations, { recursive: true, force: true });
      await rm(runtimeDir, { recursive: true, force: true });
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

  it("leaves no timers, process handlers or listener after import and createApp()", () => {
    expect(pendingAfterImport).toEqual([]);
    const remaining = pendingAfterCreateApp.map((timer) => {
      const known = INTEGRATION_SETUP_TIMER_ORIGINS.find((path) => timer.origin.includes(path));
      return known ?? timer.origin;
    });
    expect(remaining.sort()).toEqual([...INTEGRATION_SETUP_TIMER_ORIGINS].sort());
    expect(processHandlers).toEqual([]);
    expect(app.server.server.listening).toBe(false);
  });

  it("closes the task runs a previous process left running before any integration loads", async () => {
    expect(lifecycle.indexOf("recover task runs")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("recover task runs")).toBeLessThan(
      lifecycle.indexOf("load integrations"),
    );
    expect(
      await fixture.sql`select status, error from integration_task_run
        where integration_id = 'left-behind'`,
    ).toEqual([{ status: "failed", error: "interrupted by restart" }]);
  });

  it("reads the operator's safe-mode file before any installed integration is considered", async () => {
    const { getSafeMode } = await import("./safe-mode");
    const { getIntegration } = await import("./integration-host");
    expect(lifecycle.indexOf("read safe mode")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("read safe mode")).toBeLessThan(
      lifecycle.indexOf("load integrations"),
    );
    // How the previous processes ended can turn safe mode on, so it is judged first.
    expect(lifecycle.indexOf("begin boot")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("begin boot")).toBeLessThan(lifecycle.indexOf("read safe mode"));
    expect(getSafeMode()).toEqual({ active: true, reason: "operator", integrationId: null });
    expect(getIntegration("app-installed-demo")).toMatchObject({
      enabled: false,
      loadState: "safe-mode",
    });
    expect(
      (globalThis as { __omxAppInstalledEvaluated?: boolean }).__omxAppInstalledEvaluated,
    ).toBeUndefined();
    expect(lifecycle.indexOf("sync safe-mode attention")).toBeGreaterThan(
      lifecycle.indexOf("load integrations"),
    );
    expect(
      await fixture.sql`select key, title from attention_item where key = 'safe-mode'`,
    ).toEqual([{ key: "safe-mode", title: "Safe mode is on" }]);
  });

  it("keeps recording erasures for an integration that is no longer loaded and shows what it owes", async () => {
    // Its data may still exist, so deletions are still recorded for it.
    expect(await fixture.sql`select integration_id from integration_subject_handler`).toEqual([
      { integration_id: "not-installed" },
    ]);
    expect(
      await fixture.sql`select integration_id, subject_user_id from subject_erasure_pending`,
    ).toEqual([{ integration_id: "not-installed", subject_user_id: "deleted-account" }]);
    await vi.waitFor(
      async () =>
        expect(
          await fixture.sql`select key, title from attention_item
            where key = 'subject-erasure-pending:not-installed'`,
        ).toEqual([
          {
            key: "subject-erasure-pending:not-installed",
            title: "Erasure pending in not-installed",
          },
        ]),
      { timeout: 10_000, interval: 100 },
    );
  });

  it("ends a slow integration statement at the integration pool's timeout", async () => {
    const { ProviderTimeoutError } = await import("@openmapx/integration-framework");
    const { extensionSql, integrationSql } = await import("./db/index");
    const { createIntegrationDb } = await import("./integration-db");
    const [settings] = await integrationSql<{ timeout: string; name: string }[]>`
      SELECT current_setting('statement_timeout') AS timeout,
             current_setting('application_name') AS name`;
    expect(settings).toEqual({ timeout: "5s", name: "openmapx-api-integrations" });

    const started = Date.now();
    await expect(
      createIntegrationDb({ requests: integrationSql, transactions: extensionSql }).execute(
        "SELECT pg_sleep(6)",
      ),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    expect(Date.now() - started).toBeLessThan(5_900);
  }, 20_000);

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

  it("limits a core route before that route's own onRequest hook runs", async () => {
    const request = () =>
      app.server.inject({
        method: "GET",
        url: ADMIN_PLATFORM_PATH,
        remoteAddress: "203.0.113.30",
      });

    for (let attempt = 0; attempt < PUBLIC_RATE_LIMIT; attempt += 1) {
      const admitted = await request();
      expect(admitted.statusCode).toBe(401);
      expect(admitted.headers["cache-control"]).toBe("private, no-store");
    }

    const limited = await request();
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["cache-control"]).toBeUndefined();
  });

  // Runs last: stop() closes the server every other case injects into.
  it("stops cleanly after a start that could not bind its port", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Blocker has no port");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("PORT", String(address.port));
    // Start-up runs the retention jobs, which delete task runs finished more
    // than 30 days after they started.
    await fixture.sql`insert into integration_task_run
        (integration_id, task_name, status, started_at, finished_at)
      values ('pruned', 'old', 'succeeded', now() - interval '31 days', now() - interval '31 days'),
             ('pruned', 'recent', 'succeeded', now() - interval '29 days', now() - interval '29 days')`;
    // The daily run syncs the handler table before it works through the
    // pending erasures: a row for a running integration without a handler
    // goes, and the item of the integration that owes erasures comes back.
    const { getAllIntegrations } = await import("./integration-host");
    const running = getAllIntegrations().find(
      (integration) => integration.loadState === "loaded" && integration.enabled,
    );
    if (!running) throw new Error("No integration is running");
    await fixture.sql`insert into integration_subject_handler (integration_id) values (${running.id})`;
    await fixture.sql`delete from attention_item where key = 'subject-erasure-pending:not-installed'`;

    try {
      await expect(app.start()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
    await vi.waitFor(
      async () =>
        expect(
          await fixture.sql`select task_name from integration_task_run
            where integration_id = 'pruned'`,
        ).toEqual([{ task_name: "recent" }]),
      { timeout: 10_000, interval: 100 },
    );
    await vi.waitFor(
      async () => {
        expect(
          await fixture.sql`select integration_id from integration_subject_handler
            where integration_id = ${running.id}`,
        ).toEqual([]);
        expect(
          await fixture.sql`select key from attention_item
            where key = 'subject-erasure-pending:not-installed'`,
        ).toEqual([{ key: "subject-erasure-pending:not-installed" }]);
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(lifecycle).not.toContain("cancel extension migrations");
    expect(lifecycle).not.toContain("stop tasks");
    expect(JSON.parse(await readFile(join(runtimeDir, "boot-marker.json"), "utf8"))).toMatchObject({
      running: true,
    });
    const stopped = app.stop();
    // Recorded before anything is torn down, so a stop cut short by a kill is clean.
    expect(lifecycle.indexOf("mark clean stop")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.indexOf("mark clean stop")).toBeLessThan(
      lifecycle.indexOf("cancel extension migrations"),
    );
    expect(JSON.parse(await readFile(join(runtimeDir, "boot-marker.json"), "utf8"))).toMatchObject({
      running: false,
    });
    await stopped;
    // A reload may be migrating an integration while the API serves.
    expect(lifecycle).toContain("cancel extension migrations");
    expect(lifecycle).toContain("stop tasks");
    expect(lifecycle.indexOf("mark clean stop")).toBeLessThan(lifecycle.indexOf("stop tasks"));
    await expect(app.stop()).resolves.toBeUndefined();

    const healthRefreshes = [...timers.values()].filter(
      (timer) =>
        timer.origin.includes("startIntegrationHealthRefresh") &&
        timer.origin.includes("integration-host") &&
        [5_000, 60_000].includes(timer.delay ?? 0),
    );
    expect(healthRefreshes.map((timer) => timer.kind).sort()).toEqual(["interval", "timeout"]);
    expect(pendingTimers()).toEqual([]);
  }, 60_000);
});
