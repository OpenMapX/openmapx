import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Public legal reads must work independently of administration route setup.
vi.mock("../admin-settings.js", () => {
  throw new Error("Public legal settings must not load the admin route");
});
vi.mock("../../services/app-logger.js", () => ({
  // The process logger, reached through the secrets service, mirrors into this stream.
  appLogger: { add: vi.fn(), createPinoStream: () => ({ write: () => true }) },
}));

let selectResolveWith: unknown[] = [];
const mockDbSelect = vi.fn();
function makeSelectChain() {
  return {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(selectResolveWith).then(onFulfilled, onRejected);
    },
  };
}
mockDbSelect.mockImplementation(() => makeSelectChain());
vi.mock("../../db/index.js", () => ({ db: { select: (...a: unknown[]) => mockDbSelect(...a) } }));
vi.mock("../../db", () => ({ db: { select: (...a: unknown[]) => mockDbSelect(...a) } }));
vi.mock("../../db/schema.js", () => ({
  systemSetting: {
    key: "key",
    value: "value",
    updatedAt: "updatedAt",
    updatedByUserId: "updatedByUserId",
  },
  systemSecret: { key: "key" },
}));
vi.mock("../../db/schema", () => ({
  systemSetting: {
    key: "key",
    value: "value",
    updatedAt: "updatedAt",
    updatedByUserId: "updatedByUserId",
  },
  systemSecret: { key: "key" },
}));

let app: FastifyInstance;

beforeAll(async () => {
  const { legalConfigRoute } = await import("../legal-config.js");
  app = Fastify({ logger: false });
  await app.register(legalConfigRoute);
  await app.ready();
});

afterAll(() => app?.close());

beforeEach(() => {
  selectResolveWith = [];
  for (const key of [
    "LEGAL_CONTROLLER_NAME",
    "LEGAL_CONTROLLER_STREET",
    "LEGAL_CONTROLLER_POSTAL_CODE",
    "LEGAL_CONTROLLER_CITY",
    "LEGAL_CONTROLLER_COUNTRY",
    "LEGAL_CONTROLLER_EMAIL",
    "LEGAL_CONTROLLER_PHONE",
    "LEGAL_HOSTING_PROVIDER",
    "LEGAL_HOSTING_LOCATIONS",
    "LEGAL_SUPERVISORY_AUTHORITY_NAME",
    "LEGAL_SUPERVISORY_AUTHORITY_URL",
    "LEGAL_DATA_REQUEST_EMAIL",
    "LEGAL_DEPLOYMENT_JURISDICTION",
    "LEGAL_PRIVACY_SOURCES",
    "RETENTION_SERVER_LOG_DAYS",
    "RETENTION_PRIVACY_CASE_DAYS",
    "RETENTION_AUDIT_LOG_DAYS",
    "RETENTION_ADMIN_JOB_DAYS",
    "RETENTION_BACKUP_DAYS",
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /legal-config", () => {
  it("returns the defaults when nothing is configured", async () => {
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: "",
      street: "",
      postalCode: "",
      city: "",
      country: "",
      email: "",
      phone: "",
      hostingProvider: "",
      hostingLocations: "",
      supervisoryAuthority: "",
      supervisoryAuthorityUrl: "",
      serverLogRetentionDays: 30,
      dataRequestEmail: "",
      dsarCaseRetentionDays: 1095,
      deploymentJurisdiction: "",
      privacySources: [],
      backupRetentionDays: 30,
      auditLogRetentionDays: 365,
    });
  });

  it("returns admin-database values when set and no env override", async () => {
    selectResolveWith = [
      { key: "legal.controller.name", value: "OpenMapX e.V." },
      { key: "legal.controller.street", value: "Map Street 1" },
      { key: "legal.controller.postalCode", value: "10115" },
      { key: "legal.controller.city", value: "Berlin" },
      { key: "legal.controller.country", value: "Germany" },
      { key: "legal.controller.email", value: "legal@example.test" },
      { key: "legal.controller.phone", value: "+49 30 123456" },
      { key: "legal.hosting.provider", value: "Hetzner Online GmbH" },
      { key: "legal.hosting.locations", value: "Germany, Finland" },
      { key: "legal.supervisoryAuthority.name", value: "BfDI" },
      { key: "legal.supervisoryAuthority.url", value: "https://www.bfdi.bund.de" },
      { key: "retention.serverLogDays", value: 14 },
      { key: "retention.privacyCaseDays", value: 400 },
      { key: "retention.auditLogDays", value: 730 },
    ];
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json()).toEqual({
      name: "OpenMapX e.V.",
      street: "Map Street 1",
      postalCode: "10115",
      city: "Berlin",
      country: "Germany",
      email: "legal@example.test",
      phone: "+49 30 123456",
      hostingProvider: "Hetzner Online GmbH",
      hostingLocations: "Germany, Finland",
      supervisoryAuthority: "BfDI",
      supervisoryAuthorityUrl: "https://www.bfdi.bund.de",
      serverLogRetentionDays: 14,
      dataRequestEmail: "legal@example.test",
      dsarCaseRetentionDays: 400,
      deploymentJurisdiction: "",
      privacySources: [],
      backupRetentionDays: 30,
      auditLogRetentionDays: 730,
    });
  });

  it("lets the env var take priority over the admin-database value", async () => {
    selectResolveWith = [{ key: "legal.hosting.provider", value: "Hetzner Online GmbH" }];
    vi.stubEnv("LEGAL_HOSTING_PROVIDER", "OVHcloud");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("OVHcloud");
  });

  it("lets controller env values take priority over persisted controller facts", async () => {
    selectResolveWith = [
      { key: "legal.controller.name", value: "Database Controller" },
      { key: "legal.controller.email", value: "database@example.test" },
    ];
    vi.stubEnv("LEGAL_CONTROLLER_NAME", "Environment Controller");
    vi.stubEnv("LEGAL_CONTROLLER_EMAIL", "environment@example.test");

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json()).toMatchObject({
      name: "Environment Controller",
      email: "environment@example.test",
      dataRequestEmail: "environment@example.test",
    });
  });

  it("publishes a dedicated request contact when the general legal email is empty", async () => {
    selectResolveWith = [
      { key: "legal.controller.email", value: "" },
      { key: "legal.dataRequestEmail", value: "requests@example.test" },
    ];

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json()).toMatchObject({
      email: "",
      dataRequestEmail: "requests@example.test",
    });
  });

  it("states nothing rather than an invalid env or database value", async () => {
    vi.stubEnv("LEGAL_CONTROLLER_STREET", "Env Street\nInjected");
    let res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.statusCode).toBe(500);
    vi.stubEnv("LEGAL_CONTROLLER_STREET", undefined);
    selectResolveWith = [{ key: "legal.controller.street", value: "DB Street\nInjected" }];
    res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.statusCode).toBe(500);
    selectResolveWith = [{ key: "retention.serverLogDays", value: -5 }];
    res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.statusCode).toBe(500);
  });

  it("treats a blank env var as unset and falls back to the database value", async () => {
    selectResolveWith = [{ key: "legal.hosting.provider", value: "Hetzner Online GmbH" }];
    vi.stubEnv("LEGAL_HOSTING_PROVIDER", "");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("Hetzner Online GmbH");
  });

  it("lets the supervisory-authority env var win over the database value", async () => {
    selectResolveWith = [{ key: "legal.supervisoryAuthority.name", value: "DB Authority" }];
    vi.stubEnv("LEGAL_SUPERVISORY_AUTHORITY_NAME", "Env Authority");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().supervisoryAuthority).toBe("Env Authority");
  });

  it("publishes the retention periods the environment sets", async () => {
    vi.stubEnv("RETENTION_SERVER_LOG_DAYS", "7");
    vi.stubEnv("RETENTION_BACKUP_DAYS", "14");
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", "730");
    vi.stubEnv("RETENTION_PRIVACY_CASE_DAYS", "60");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json()).toMatchObject({
      serverLogRetentionDays: 7,
      backupRetentionDays: 14,
      auditLogRetentionDays: 730,
      dsarCaseRetentionDays: 60,
    });
  });
});
