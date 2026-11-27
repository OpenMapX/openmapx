import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "./app";
import { createMigratedPostgresFixture } from "./test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

const CLOSED_LOCAL_URL = "http://127.0.0.1:9";

describeDatabase("a start of createApp() after the third unclean exit", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let runtimeDir: string;
  let customIntegrations: string;
  let app: App;

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    // Left raised and acknowledged by a start whose resolution of it failed.
    await fixture.sql`insert into attention_item (key, severity, source, title, acknowledged_at)
      values ('safe-mode', 'warning', 'safe-mode', 'Safe mode is on', now())`;
    runtimeDir = await mkdtemp(join(tmpdir(), "openmapx-app-runtime-"));
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    await writeFile(
      join(runtimeDir, "boot-marker.json"),
      JSON.stringify({
        version: 1,
        running: true,
        installedCodeStarted: true,
        current: { integrationId: "acme-places", phase: "setup" },
        lastFatal: null,
        uncleanExits: [
          { at: minuteAgo, integrationId: "acme-places" },
          { at: minuteAgo, integrationId: "acme-places" },
        ],
      }),
    );
    customIntegrations = await mkdtemp(join(tmpdir(), "openmapx-app-integrations-"));
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

  it("starts in automatic safe mode naming the integration", async () => {
    const { getSafeMode } = await import("./safe-mode");
    expect(getSafeMode()).toEqual({
      active: true,
      reason: "automatic",
      integrationId: "acme-places",
    });
    expect(JSON.parse(await readFile(join(runtimeDir, "safe-mode.json"), "utf8"))).toEqual({
      mode: "automatic",
      integrationId: "acme-places",
    });
    expect(JSON.parse(await readFile(join(runtimeDir, "boot-marker.json"), "utf8"))).toMatchObject({
      running: true,
      installedCodeStarted: false,
      uncleanExits: [],
    });
  });

  it("raises a fresh attention item that says why", async () => {
    const [item] = await fixture.sql<
      Array<{ title: string; detail: string; acknowledged_at: Date | null }>
    >`select title, detail, acknowledged_at from attention_item where key = 'safe-mode'`;
    expect(item).toMatchObject({
      title: "Safe mode after repeated crashes",
      acknowledged_at: null,
    });
    expect(item?.detail).toContain("acme-places");
  });
});
