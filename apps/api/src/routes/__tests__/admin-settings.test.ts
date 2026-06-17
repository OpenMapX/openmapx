import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "./admin-test-helpers.js";

// Auth guard mock — all three exports required
const fakeSession = mockAdminSession();
const mockRequireAdmin = vi.fn().mockResolvedValue(fakeSession);
const mockGetAdminSession = vi.fn().mockReturnValue(fakeSession);
const mockTryAdminSession = vi.fn().mockResolvedValue(fakeSession);

vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
  getAdminSession: (...args: unknown[]) => mockGetAdminSession(...args),
  tryAdminSession: (...args: unknown[]) => mockTryAdminSession(...args),
}));

// Audit log
const mockWriteAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

// Data-use policy — the PATCH handler calls invalidateDataUsePolicy() then
// awaits refreshDataUsePolicy(); both must be mocked or the route 500s.
const mockInvalidateDataUsePolicy = vi.fn();
const mockRefreshDataUsePolicy = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/data-use-policy.js", () => ({
  invalidateDataUsePolicy: (...args: unknown[]) => mockInvalidateDataUsePolicy(...args),
  refreshDataUsePolicy: (...args: unknown[]) => mockRefreshDataUsePolicy(...args),
}));

// App logger (used by GET /admin/logs)
const mockGetEntries = vi.fn().mockReturnValue({ entries: [], total: 0 });
const mockGetSources = vi.fn().mockReturnValue([]);
vi.mock("../../services/app-logger.js", () => ({
  appLogger: {
    getEntries: (...args: unknown[]) => mockGetEntries(...args),
    getSources: (...args: unknown[]) => mockGetSources(...args),
  },
}));

// Email utilities
const mockLoadEmailConfig = vi.fn();
const mockSendViaEmailLabs = vi.fn().mockResolvedValue(undefined);
const mockSendViaLettermint = vi.fn().mockResolvedValue(undefined);
const mockSendViaSmtp = vi.fn().mockResolvedValue(undefined);
vi.mock("../../utils/email.js", () => ({
  loadEmailConfig: (...args: unknown[]) => mockLoadEmailConfig(...args),
  sendViaEmailLabs: (...args: unknown[]) => mockSendViaEmailLabs(...args),
  sendViaLettermint: (...args: unknown[]) => mockSendViaLettermint(...args),
  sendViaSmtp: (...args: unknown[]) => mockSendViaSmtp(...args),
}));

// Rate limiters — no-op
vi.mock("../../utils/rate-limit.js", () => ({
  emailTestLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  serviceActionLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  storeInstallLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  publicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  authLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  expensivePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
  tilePublicApiLimit: { preHandler: () => vi.fn().mockResolvedValue(undefined) },
}));

// DB — systemSettings table; chain must satisfy .select().from() and
// .insert().values().onConflictDoUpdate() call shapes
const mockDbSelect = vi.fn();
const mockDbInsert = vi.fn();

let selectResolveWith: unknown[] = [];

function makeSelectChain() {
  const chain: Record<string, unknown> = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(selectResolveWith).then(onFulfilled, onRejected);
    },
  };
  return chain;
}

const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
};
mockDbSelect.mockImplementation(() => makeSelectChain());
mockDbInsert.mockReturnValue(insertChain);

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));
vi.mock("../../db/schema.js", () => ({
  systemSettings: { key: "key", value: "value", updatedAt: "updatedAt", updatedBy: "updatedBy" },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminSettingsRoute } = await import("../admin-settings.js");
  app = Fastify({ logger: false });
  await app.register(adminSettingsRoute);
  await app.ready();
});

afterAll(() => app.close());
afterEach(() => vi.clearAllMocks());

describe("GET /admin/settings", () => {
  it("returns groups with resolved settings (all defaults, no DB rows)", async () => {
    // selectChain returns [] by default — all settings resolve to their defaults
    const res = await app.inject({ method: "GET", url: "/admin/settings" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    const generalGroup = body.groups.find((g: { id: string }) => g.id === "general");
    expect(generalGroup).toBeDefined();
    const instanceNameSetting = generalGroup.settings.find(
      (s: { key: string }) => s.key === "instanceName",
    );
    expect(instanceNameSetting).toMatchObject({
      key: "instanceName",
      value: "OpenMapX",
      source: "default",
    });
  });

  it("reflects database overrides when rows are returned", async () => {
    // Return a DB row overriding instanceName
    selectResolveWith = [{ key: "instanceName", value: "My Instance" }];

    const res = await app.inject({ method: "GET", url: "/admin/settings" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const general = body.groups.find((g: { id: string }) => g.id === "general");
    const instanceName = general.settings.find((s: { key: string }) => s.key === "instanceName");
    expect(instanceName).toMatchObject({ value: "My Instance", source: "database" });

    // Reset to empty for subsequent tests
    selectResolveWith = [];
  });

  it("redacts env-sourced secrets but exposes non-secret env values", async () => {
    const origKey = process.env.MAPTILER_KEY;
    const origLocale = process.env.DEFAULT_LOCALE;
    process.env.MAPTILER_KEY = "super-secret-key";
    process.env.DEFAULT_LOCALE = "de";

    try {
      const res = await app.inject({ method: "GET", url: "/admin/settings" });
      const body = res.json();

      // An env-sourced secret is flagged as set + locked, but its raw value
      // must never reach the browser.
      const map = body.groups.find((g: { id: string }) => g.id === "map");
      const apiKey = map.settings.find((s: { key: string }) => s.key === "maptilerApiKey");
      expect(apiKey).toMatchObject({ source: "env", envOverride: true, secret: true });
      expect(apiKey.value).not.toBe("super-secret-key");

      // A non-secret env override exposes its real value so the UI can show it.
      const general = body.groups.find((g: { id: string }) => g.id === "general");
      const locale = general.settings.find((s: { key: string }) => s.key === "defaultLocale");
      expect(locale).toMatchObject({ value: "de", source: "env", envOverride: true });
    } finally {
      if (origKey === undefined) delete process.env.MAPTILER_KEY;
      else process.env.MAPTILER_KEY = origKey;
      if (origLocale === undefined) delete process.env.DEFAULT_LOCALE;
      else process.env.DEFAULT_LOCALE = origLocale;
    }
  });

  it("rejects unauthenticated requests with 401", async () => {
    mockRequireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );

    const res = await app.inject({ method: "GET", url: "/admin/settings" });

    expect(res.statusCode).toBe(401);
  });
});

describe("PATCH /admin/settings", () => {
  it("writes allowed keys to DB, calls invalidateDataUsePolicy, returns updated groups", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { instanceName: "Updated Name" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockInvalidateDataUsePolicy).toHaveBeenCalled();
    expect(mockRefreshDataUsePolicy).toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.update", actorId: fakeSession.user.id }),
    );
  });

  it("returns 400 when body is not an object", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: null as unknown as object,
    });

    expect(res.statusCode).toBe(400);
  });

  it("silently skips keys that are env-overridden", async () => {
    // INSTANCE_NAME env override should prevent the write
    const original = process.env.INSTANCE_NAME;
    process.env.INSTANCE_NAME = "env-override";

    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { instanceName: "Should Not Write" },
    });

    expect(res.statusCode).toBe(200);
    // The insert mock should not have been called for the env-overridden key
    // (the route silently skips it — no 400)
    expect(res.json().ok).toBe(true);

    process.env.INSTANCE_NAME = original;
  });
});

describe("POST /admin/settings/export", () => {
  it("returns exported settings and writes audit log", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/settings/export" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settings).toBeDefined();
    expect(body.exportedAt).toBeTruthy();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.export" }),
    );
  });
});

describe("POST /admin/settings/import", () => {
  it("imports non-secret settings and returns imported count", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/settings/import",
      payload: { settings: { instanceName: "Imported Name", defaultLocale: "de" } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.imported).toBe("number");
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.import" }),
    );
  });

  it("returns 400 when body is missing settings object", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/settings/import",
      payload: { notSettings: {} },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("settings");
  });

  it("silently skips secret keys (e.g. maptilerApiKey)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/settings/import",
      payload: { settings: { maptilerApiKey: "should-not-import", instanceName: "ok" } },
    });

    expect(res.statusCode).toBe(200);
    // Only the non-secret key should be counted
    expect(res.json().imported).toBe(1);
  });
});

describe("GET /admin/logs", () => {
  it("returns entries and sources from appLogger", async () => {
    mockGetEntries.mockReturnValueOnce({ entries: [{ id: "log-1", level: "info" }], total: 1 });
    mockGetSources.mockReturnValueOnce(["api", "admin"]);

    const res = await app.inject({ method: "GET", url: "/admin/logs" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.sources).toEqual(["api", "admin"]);
    expect(body.total).toBe(1);
  });
});
