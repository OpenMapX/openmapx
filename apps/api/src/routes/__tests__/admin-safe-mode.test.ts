import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAttentionMocks,
  createIntegrationHostTestApp as makeHostApp,
} from "../../__tests__/support/integration-host-environment.js";
import { installAdminRouteMocks } from "./admin-test-helpers.js";

const { requireAdmin, writeAuditLog, session } = installAdminRouteMocks();

const { getIntegration, initIntegrations, shutdownIntegrations } = await import(
  "../../integration-host.js"
);
const { initSafeMode, isSafeModeActive } = await import("../../safe-mode.js");
const { adminSafeModeRoute } = await import("../admin-safe-mode.js");

let parent: string;
let runtimeDir: string;
let app: FastifyInstance;

function writeInstalled(id: string) {
  const directory = join(parent, "installed", id);
  mkdirSync(join(directory, "dist", "backend"), { recursive: true });
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      id,
      version: "1.0.0",
      platform: "1.0",
      license: "MIT",
      domains: ["knowledge"],
      quality: "community",
      backend: { entry: "dist/backend/index.mjs" },
    }),
  );
  writeFileSync(
    join(directory, "dist", "backend", "index.mjs"),
    `// admin safe mode ${parent}\nexport function setup() {}\n`,
  );
}

beforeEach(async () => {
  parent = mkdtempSync(join(tmpdir(), "omx-admin-safe-mode-"));
  runtimeDir = join(parent, "runtime");
  mkdirSync(runtimeDir);
  vi.stubEnv("OPENMAPX_INTEGRATION_CODE_CACHE_DIR", join(parent, "code-cache"));
  writeInstalled("installed-demo");
  app = Fastify({ logger: false });
  await app.register(adminSafeModeRoute, { prefix: "/api" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await shutdownIntegrations();
  initSafeMode({}, runtimeDir);
  vi.unstubAllEnvs();
  rmSync(parent, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function boot(env: NodeJS.ProcessEnv, file: string | null) {
  if (file !== null) writeFileSync(join(runtimeDir, "safe-mode.json"), file);
  initSafeMode(env, runtimeDir);
  await initIntegrations(makeHostApp(), [
    { directory: join(parent, "installed"), isBuiltIn: false },
  ]);
}

describe("safe mode administration", () => {
  it("reports the state", async () => {
    await boot({}, '{"mode":"automatic","integrationId":"installed-demo"}');

    const response = await app.inject({ method: "GET", url: "/api/admin/safe-mode" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      active: true,
      reason: "automatic",
      integrationId: "installed-demo",
    });
  });

  it("leaves safe mode and loads installed integrations", async () => {
    await boot({}, '{"mode":"operator"}');
    expect(getIntegration("installed-demo")?.loadState).toBe("safe-mode");

    const response = await app.inject({ method: "POST", url: "/api/admin/safe-mode/leave" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ active: false, reason: null, integrationId: null });
    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(false);
    expect(getIntegration("installed-demo")?.loadState).toBe("loaded");
    expect(isSafeModeActive()).toBe(false);
    expect(getAttentionMocks().resolveAttention).toHaveBeenCalledWith("safe-mode");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: session.user.id,
        action: "safe_mode.leave",
        details: { reason: "operator", integrationId: null },
      }),
    );
    const listed = await app.inject({ method: "GET", url: "/api/admin/safe-mode" });
    expect(listed.json()).toEqual({ active: false, reason: null, integrationId: null });
  });

  it("refuses to leave safe mode the environment forces", async () => {
    await boot({ OPENMAPX_SAFE_MODE: "1" }, null);

    const response = await app.inject({ method: "POST", url: "/api/admin/safe-mode/leave" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "Safe mode is forced by OPENMAPX_SAFE_MODE" });
    expect(getIntegration("installed-demo")?.loadState).toBe("safe-mode");
    expect(isSafeModeActive()).toBe(true);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("requires an admin session", async () => {
    await boot({}, '{"mode":"operator"}');
    for (const request of [
      { method: "GET" as const, url: "/api/admin/safe-mode" },
      { method: "POST" as const, url: "/api/admin/safe-mode/leave" },
    ]) {
      requireAdmin.mockRejectedValueOnce(
        Object.assign(new Error("Authentication required"), { statusCode: 401 }),
      );
      expect((await app.inject(request)).statusCode).toBe(401);
    }
    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(isSafeModeActive()).toBe(true);
  });
});
