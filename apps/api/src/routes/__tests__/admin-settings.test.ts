import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTING_DEFS,
  SecretSettingUnreadableError,
  settingEnvName,
} from "../../services/settings";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";

const {
  session: fakeSession,
  requireAdmin: mockRequireAdmin,
  writeAuditLog: mockWriteAuditLog,
} = installAdminRouteMocks();

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
    add: vi.fn(),
    getEntries: (...args: unknown[]) => mockGetEntries(...args),
    getSources: (...args: unknown[]) => mockGetSources(...args),
    // The process logger, reached through the integration host, mirrors into this stream.
    createPinoStream: () => ({ write: () => true }),
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

// DB — systemSetting table; chain must satisfy .select().from() and
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
const deleteChain = { where: vi.fn().mockResolvedValue(undefined) };
const mockDbDelete = vi.fn();
mockDbSelect.mockImplementation(() => makeSelectChain());
mockDbInsert.mockReturnValue(insertChain);
mockDbDelete.mockReturnValue(deleteChain);

vi.mock("../../db/index.js", () => ({
  db: {
    select: (...args: unknown[]) => mockDbSelect(...args),
    insert: (...args: unknown[]) => mockDbInsert(...args),
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        insert: (...args: unknown[]) => mockDbInsert(...args),
        delete: (...args: unknown[]) => mockDbDelete(...args),
      }),
  },
}));
vi.mock("../../db/schema.js", () => ({
  systemSetting: {
    key: "key",
    value: "value",
    updatedAt: "updatedAt",
    updatedByUserId: "updatedByUserId",
  },
  systemSecret: { key: "key", updatedAt: "updatedAt", updatedByUserId: "updatedByUserId" },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { adminSettingsRoute } = await import("../admin-settings.js");
  app = await createAdminTestApp(adminSettingsRoute);
});

afterAll(() => app?.close());
beforeEach(() => {
  for (const definition of SETTING_DEFS) vi.stubEnv(settingEnvName(definition.key), undefined);
});
afterEach(() => {
  selectResolveWith = [];
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("GET /admin/settings", () => {
  it("returns groups with resolved settings (all defaults, no DB rows)", async () => {
    // selectChain returns [] by default — all settings resolve to their defaults
    const res = await app.inject({ method: "GET", url: "/admin/settings" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.groups.map((g: { id: string }) => g.id)).toEqual([
      "auth",
      "email",
      "map",
      "policy",
      "legal",
      "extensions",
    ]);
    const email = body.groups.find((g: { id: string }) => g.id === "email");
    expect(email.settings.find((s: { key: string }) => s.key === "smtp.security")).toMatchObject({
      value: "starttls",
      source: "default",
      envVar: "SMTP_SECURITY",
      options: ["starttls", "tls", "none"],
    });
  });

  it("reflects database overrides when rows are returned", async () => {
    selectResolveWith = [{ key: "smtp.host", value: "mail.example.test" }];

    const res = await app.inject({ method: "GET", url: "/admin/settings" });

    expect(res.statusCode).toBe(200);
    const email = res.json().groups.find((g: { id: string }) => g.id === "email");
    const host = email.settings.find((s: { key: string }) => s.key === "smtp.host");
    expect(host).toMatchObject({ value: "mail.example.test", source: "database" });
  });

  it("redacts env-sourced secrets but exposes non-secret env values", async () => {
    vi.stubEnv("MAPTILER_API_KEY", "super-secret-key");
    vi.stubEnv("SMTP_HOST", "mail.env.test");

    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    const body = res.json();

    // An env-sourced secret is flagged as set + locked, but its raw value
    // must never reach the browser.
    const map = body.groups.find((g: { id: string }) => g.id === "map");
    const apiKey = map.settings.find((s: { key: string }) => s.key === "maptiler.apiKey");
    expect(apiKey).toMatchObject({ source: "env", envOverride: true, secret: true });
    expect(apiKey.value).not.toBe("super-secret-key");

    // A non-secret env override exposes its real value so the UI can show it.
    const email = body.groups.find((g: { id: string }) => g.id === "email");
    const host = email.settings.find((s: { key: string }) => s.key === "smtp.host");
    expect(host).toMatchObject({ value: "mail.env.test", source: "env", envOverride: true });
  });

  it("refuses to show settings while an environment value is invalid", async () => {
    vi.stubEnv("SMTP_PORT", "five");
    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    expect(res.statusCode).toBe(500);
  });

  it("shows the backup period only the environment sets as locked", async () => {
    vi.stubEnv("RETENTION_BACKUP_DAYS", "14");
    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    const legal = res.json().groups.find((g: { id: string }) => g.id === "legal");
    expect(
      legal.settings.find((s: { key: string }) => s.key === "retention.backupDays"),
    ).toMatchObject({
      value: 14,
      source: "env",
      envOverride: true,
      envVar: "RETENTION_BACKUP_DAYS",
    });
    vi.stubEnv("RETENTION_BACKUP_DAYS", undefined);
    const fallback = await app.inject({ method: "GET", url: "/admin/settings" });
    expect(
      fallback
        .json()
        .groups.find((g: { id: string }) => g.id === "legal")
        .settings.find((s: { key: string }) => s.key === "retention.backupDays"),
    ).toMatchObject({ value: 30, source: "default", envOverride: true });
  });

  it("keeps the live MapTiler key but drops the dead style-provider controls from the map group", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    const body = res.json();

    const map = body.groups.find((g: { id: string }) => g.id === "map");
    const keys = map.settings.map((s: { key: string }) => s.key);

    // The base style provider is env-only (NEXT_PUBLIC_STYLE_PROVIDER); the old
    // MAP_STYLE_PROVIDER / CUSTOM_STYLE_URL admin fields drove nothing and are gone.
    expect(keys).toContain("maptiler.apiKey");
    expect(keys).not.toContain("styleProvider");
    expect(keys).not.toContain("customStyleUrl");

    // With the provider dropdown gone, the key must not be gated behind a
    // (now non-existent) styleProvider value — it always renders.
    const apiKey = map.settings.find((s: { key: string }) => s.key === "maptiler.apiKey");
    expect(apiKey.showWhen).toBeUndefined();
  });

  it("exposes editable operator, contact, governance and retention facts in stable subgroups", async () => {
    selectResolveWith = [
      { key: "legal.controller.name", value: "Persisted Controller" },
      { key: "legal.controller.email", value: "legal@example.test" },
    ];

    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    const legal = res.json().groups.find((group: { id: string }) => group.id === "legal");
    const byKey = Object.fromEntries(
      legal.settings.map((setting: { key: string }) => [setting.key, setting]),
    );

    expect(byKey["legal.controller.name"]).toMatchObject({
      subgroup: "operator",
      value: "Persisted Controller",
      source: "database",
      envVar: "LEGAL_CONTROLLER_NAME",
    });
    expect(byKey["legal.controller.street"].subgroup).toBe("operator");
    expect(byKey["legal.controller.postalCode"].subgroup).toBe("operator");
    expect(byKey["legal.controller.city"].subgroup).toBe("operator");
    expect(byKey["legal.controller.country"].subgroup).toBe("operator");
    expect(byKey["legal.controller.email"]).toMatchObject({
      subgroup: "contact",
      value: "legal@example.test",
    });
    expect(byKey["legal.controller.phone"].subgroup).toBe("contact");
    expect(byKey["legal.dataRequestEmail"].subgroup).toBe("contact");
    expect(byKey["legal.supervisoryAuthority.name"].subgroup).toBe("governance");
    expect(byKey["legal.deploymentJurisdiction"].subgroup).toBe("governance");
    for (const key of [
      "retention.serverLogDays",
      "retention.privacyCaseDays",
      "retention.auditLogDays",
      "retention.adminJobDays",
      "retention.backupDays",
    ])
      expect(byKey[key].subgroup).toBe("retention");
  });

  it("keeps the request-contact field editable when only the controller email is env-managed", async () => {
    vi.stubEnv("LEGAL_CONTROLLER_EMAIL", "legal@example.test");
    vi.stubEnv("LEGAL_DATA_REQUEST_EMAIL", "");

    const res = await app.inject({ method: "GET", url: "/admin/settings" });
    const legal = res.json().groups.find((group: { id: string }) => group.id === "legal");
    const requestEmail = legal.settings.find(
      (setting: { key: string }) => setting.key === "legal.dataRequestEmail",
    );

    expect(requestEmail).toMatchObject({ value: "", source: "default", envOverride: false });
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
      payload: { "smtp.host": "mail.example.test" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(mockDbInsert).toHaveBeenCalled();
    expect(mockInvalidateDataUsePolicy).toHaveBeenCalled();
    expect(mockRefreshDataUsePolicy).toHaveBeenCalled();
    expect(mockWriteAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "setting.update", actorId: fakeSession.user.id }),
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

  it("rejects a value that does not match the declared number type", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "auth.sessionDurationHours": "abc" },
    });

    expect(res.statusCode).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it.each([
    ["legal.controller.name", "   "],
    ["legal.controller.street", "Street 1\nUnexpected line"],
    ["legal.controller.email", "not-an-email"],
    ["legal.dataRequestEmail", "privacy at example.test"],
    ["legal.supervisoryAuthority.url", "javascript:alert(1)"],
    ["retention.privacyCaseDays", 14],
    ["smtp.security", "true"],
  ])("rejects unsafe legal setting %s", async (key, value) => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { [key]: value },
    });

    expect(res.statusCode).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it("writes a value that matches the declared number type", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "auth.sessionDurationHours": 24 },
    });

    expect(res.statusCode).toBe(200);
    expect(mockDbInsert).toHaveBeenCalled();
  });

  it("rejects a value that does not match the declared boolean type", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "dataUse.allowNonCommercial": "yes" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("silently skips keys that are env-overridden", async () => {
    // An SMTP_HOST env override prevents the write; the backup period is never stored.
    vi.stubEnv("SMTP_HOST", "mail.env.test");

    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "smtp.host": "Should Not Write", "retention.backupDays": 14 },
    });

    expect(res.statusCode).toBe(200);
    // The insert mock should not have been called for the env-overridden key
    // (the route silently skips it — no 400)
    expect(res.json().ok).toBe(true);

    expect(mockDbInsert).not.toHaveBeenCalled();
  });
});

describe("POST /admin/settings/test-email", () => {
  const smtp = { provider: "smtp", from: "maps@example.test", smtp: { host: "mail.example.test" } };

  it("sends through the configured provider and reports the recipient", async () => {
    mockLoadEmailConfig.mockResolvedValueOnce(smtp);
    const res = await app.inject({ method: "POST", url: "/admin/settings/test-email" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      message: `Test email sent to ${fakeSession.user.email} via smtp`,
    });
    expect(mockSendViaSmtp).toHaveBeenCalledOnce();
  });

  it("names the missing provider input before sending", async () => {
    mockLoadEmailConfig.mockResolvedValueOnce({ ...smtp, smtp: { host: "" } });
    const res = await app.inject({ method: "POST", url: "/admin/settings/test-email" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "SMTP host is not configured" });
    expect(mockSendViaSmtp).not.toHaveBeenCalled();
  });

  it("says which stored credential the secrets key cannot open, with 400", async () => {
    const error = new SecretSettingUnreadableError(
      "smtp.password",
      new Error("A stored secret cannot be decrypted with the configured secrets key"),
    );
    mockLoadEmailConfig.mockRejectedValueOnce(error);
    const res = await app.inject({ method: "POST", url: "/admin/settings/test-email" });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: error.message });
    expect(res.json().error).toMatch(/smtp\.password cannot be read: A stored secret cannot be/);
    expect(mockSendViaSmtp).not.toHaveBeenCalled();
  });

  it("keeps the provider's failure detail in the reply", async () => {
    mockLoadEmailConfig.mockResolvedValueOnce(smtp);
    mockSendViaSmtp.mockRejectedValueOnce(new Error("connection refused"));
    const res = await app.inject({ method: "POST", url: "/admin/settings/test-email" });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "Failed to send test email",
      details: "connection refused",
    });
  });
});

describe("GET /admin/logs", () => {
  it("returns entries and sources from appLogger", async () => {
    mockGetEntries.mockReturnValueOnce({
      entries: [
        {
          id: 1,
          level: "info",
          source: "api",
          message: "started",
          time: 1,
          metadata: { port: 3001 },
        },
      ],
      total: 1,
    });
    mockGetSources.mockReturnValueOnce(["api", "admin"]);

    const res = await app.inject({ method: "GET", url: "/admin/logs" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toEqual([
      {
        id: 1,
        level: "info",
        source: "api",
        message: "started",
        time: 1,
        metadata: { port: 3001 },
      },
    ]);
    expect(body.sources).toEqual(["api", "admin"]);
    expect(body.total).toBe(1);
  });
});

describe("admin settings authentication", () => {
  it.each([
    ["PATCH", "/admin/settings", null],
    ["PATCH", "/admin/settings", { "basemap.provider": "unknown" }],
    ["GET", "/admin/logs?limit=all", undefined],
  ] as const)(
    "answers %s %s with 401 before validating its input",
    async (method, url, payload) => {
      const valid = await app.inject({ method, url, payload: payload as never });
      expect(valid.statusCode).toBe(400);

      mockRequireAdmin.mockRejectedValueOnce(
        Object.assign(new Error("Authentication required"), { statusCode: 401 }),
      );
      const res = await app.inject({ method, url, payload: payload as never });
      expect(res.statusCode).toBe(401);
    },
  );
});

describe("hosted basemap admin selection", () => {
  it("accepts a valid hosted preference and rejects unknown choices", async () => {
    const valid = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "basemap.provider": "openfreemap" },
    });
    expect(valid.statusCode).toBe(200);
    const invalid = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "basemap.provider": "unknown" },
    });
    expect(invalid.statusCode).toBe(400);
  });
});

describe("map settings review regressions", () => {
  it("preserves a redacted secret when saving a hosted provider", async () => {
    selectResolveWith = [{ key: "maptiler.apiKey", value: "existing-key" }];
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "basemap.provider": "openfreemap", "maptiler.apiKey": "***" },
    });
    expect(res.statusCode).toBe(200);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "basemap.provider",
        value: "openfreemap",
      }),
    );
  });
  it("stores an explicit secret replacement encrypted", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 0x5a).toString("base64url"));
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "maptiler.apiKey": "replacement-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    const [row] = insertChain.values.mock.calls[0] ?? [];
    expect(row).toMatchObject({
      key: "maptiler.apiKey",
      ciphertext: expect.any(String),
      iv: expect.any(String),
      tag: expect.any(String),
    });
    expect(row).not.toHaveProperty("value");
    expect(JSON.stringify(row)).not.toContain("replacement-key");
  });
  it("removes a secret cleared to empty, even without a key", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", undefined);
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "maptiler.apiKey": "" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockDbDelete).toHaveBeenCalledTimes(1);
    expect(insertChain.values).not.toHaveBeenCalled();
  });
  it("refuses to save a secret without a usable key and says how to get one", async () => {
    vi.stubEnv("OPENMAPX_SECRETS_KEY", Buffer.alloc(32, 0x5a).toString("hex"));
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "maptiler.apiKey": "replacement-key", "basemap.provider": "openfreemap" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/64-character hex format is not accepted/);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });
  it("locks the provider while the environment sets it, and saves it otherwise", async () => {
    vi.stubEnv("BASEMAP_PROVIDER", "maptiler");
    const get = await app.inject("/admin/settings");
    expect(get.statusCode).toBe(200);
    const setting = get
      .json()
      .groups.find((g: { id: string }) => g.id === "map")
      .settings.find((s: { key: string }) => s.key === "basemap.provider");
    expect(setting).toMatchObject({ envOverride: true, value: "maptiler" });
    vi.stubEnv("BASEMAP_PROVIDER", "");
    const res = await app.inject({
      method: "PATCH",
      url: "/admin/settings",
      payload: { "basemap.provider": "openfreemap" },
    });
    expect(res.statusCode).toBe(200);
    expect(insertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ key: "basemap.provider", value: "openfreemap" }),
    );
  });
});
