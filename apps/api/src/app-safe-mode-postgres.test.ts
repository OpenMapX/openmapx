import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "./app";
import { createMigratedPostgresFixture } from "./test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

/** What the start and the stop did to the watchdog, in order, with the installed import. */
const lifecycle = vi.hoisted(() => {
  const calls: string[] = [];
  (globalThis as { __omxAppLifecycle?: string[] }).__omxAppLifecycle = calls;
  return calls;
});

vi.mock("./event-loop-watchdog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./event-loop-watchdog")>();
  return {
    ...actual,
    startEventLoopWatchdog: ({ thresholdMs }: { thresholdMs: number }) => {
      lifecycle.push(`start watchdog ${thresholdMs}`);
      return {
        stop: () => lifecycle.push("stop watchdog"),
        setThreshold: (ms: number) => lifecycle.push(`set watchdog threshold ${ms}`),
      };
    },
  };
});

vi.mock("./safe-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./safe-mode")>();
  return {
    ...actual,
    markCleanStop: () => {
      lifecycle.push("mark clean stop");
      actual.markCleanStop();
    },
  };
});

const CLOSED_LOCAL_URL = "http://127.0.0.1:9";

describeDatabase("a start of createApp() without the safe-mode file", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let runtimeDir: string;
  let customIntegrations: string;
  let app: App;

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    // The item an earlier start in safe mode left raised.
    await fixture.sql`insert into attention_item (key, severity, source, title)
      values ('safe-mode', 'warning', 'safe-mode', 'Safe mode is on')`;
    runtimeDir = await mkdtemp(join(tmpdir(), "openmapx-app-runtime-"));
    customIntegrations = await mkdtemp(join(tmpdir(), "openmapx-app-integrations-"));
    // An installed integration whose code records when it was imported.
    const installed = join(customIntegrations, "app-watched-demo");
    await mkdir(join(installed, "dist", "backend"), { recursive: true });
    await writeFile(
      join(installed, "manifest.json"),
      JSON.stringify({
        id: "app-watched-demo",
        name: "App Watched Demo",
        version: "1.0.0",
        platform: "1.0",
        license: "MIT",
        domains: ["knowledge"],
        quality: "community",
        backend: { entry: "dist/backend/index.mjs" },
      }),
    );
    await writeFile(
      join(installed, "dist", "backend", "index.mjs"),
      'globalThis.__omxAppLifecycle?.push("installed import");\nexport function setup() {}\n',
    );
    vi.stubEnv("OPENMAPX_EVENT_LOOP_WATCHDOG_MS", "30000");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("PORT", "0");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LOG_LEVEL", "silent");
    vi.stubEnv("DATABASE_URL", fixture.connectionUri);
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("BETTER_AUTH_SECRET", "fixture-secret-with-enough-length-for-auth-0123456789");
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 0xab).toString("base64url"));
    vi.stubEnv("CORS_ORIGIN", "https://web.example.test");
    vi.stubEnv("OSM_API_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_WEB_URL", CLOSED_LOCAL_URL);
    vi.stubEnv("OSM_DISCOVERY_URL", `${CLOSED_LOCAL_URL}/.well-known/openid-configuration`);
    vi.stubEnv("OPENMAPX_CUSTOM_INTEGRATIONS_DIR", customIntegrations);
    vi.stubEnv("OPENMAPX_API_RUNTIME_DIR", runtimeDir);
    vi.stubEnv("OPENMAPX_SAFE_MODE", "");
    // Integration setup may request its upstreams; keep this suite off the network.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("External network forbidden in the application fixture");
      }),
    );
    const { createApp } = await import("./app");
    app = await createApp();
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
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(runtimeDir, { recursive: true, force: true });
      await rm(customIntegrations, { recursive: true, force: true });
      await fixture?.stop();
    }
  }, 60_000);

  it("is not in safe mode and resolves the safe-mode item", async () => {
    const { getSafeMode } = await import("./safe-mode");
    expect(getSafeMode()).toEqual({ active: false, reason: null, integrationId: null });
    expect(await fixture.sql`select key from attention_item where key = 'safe-mode'`).toEqual([]);
  });

  it("watches the start from the first installed import and switches to the run-time threshold once it listens", async () => {
    const { getIntegration } = await import("./integration-host");
    expect(getIntegration("app-watched-demo")?.loadState).toBe("loaded");
    expect(lifecycle.slice(0, 2)).toEqual(["start watchdog 60000", "installed import"]);

    app.server.addHook("onListen", async () => {
      lifecycle.push("listening");
    });
    await app.start();
    expect(lifecycle.slice(2)).toEqual(["listening", "set watchdog threshold 30000"]);

    await app.stop();
    // The stop is recorded before the watchdog goes, so a stop it would
    // otherwise end with a kill counts as clean.
    expect(lifecycle.slice(4)).toEqual(["mark clean stop", "stop watchdog"]);
  });
});
