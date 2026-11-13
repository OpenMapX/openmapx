import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Public legal reads must work independently of administration route setup.
vi.mock("../admin-settings.js", () => {
  throw new Error("Public legal settings must not load the admin route");
});
vi.mock("../../services/app-logger.js", () => ({
  appLogger: { add: vi.fn() },
}));

let selectResolveWith: unknown[] = [];
const mockDbSelect = vi.fn();
function makeSelectChain() {
  return {
    from: vi.fn().mockReturnThis(),
    // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; stub must mirror that.
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      return Promise.resolve(selectResolveWith).then(onFulfilled, onRejected);
    },
  };
}
mockDbSelect.mockImplementation(() => makeSelectChain());
vi.mock("../../db/index.js", () => ({ db: { select: (...a: unknown[]) => mockDbSelect(...a) } }));
vi.mock("../../db/schema.js", () => ({
  systemSettings: { key: "key", value: "value", updatedAt: "updatedAt", updatedBy: "updatedBy" },
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
    "LEGAL_NAME",
    "LEGAL_STREET",
    "LEGAL_POSTAL_CODE",
    "LEGAL_CITY",
    "LEGAL_COUNTRY",
    "LEGAL_EMAIL",
    "LEGAL_PHONE",
    "LEGAL_HOSTING_PROVIDER",
    "LEGAL_HOSTING_LOCATIONS",
    "LEGAL_SUPERVISORY_AUTHORITY",
    "LEGAL_SUPERVISORY_AUTHORITY_URL",
    "LEGAL_SERVER_LOG_RETENTION_DAYS",
    "LEGAL_DATA_REQUEST_EMAIL",
    "LEGAL_DSAR_CASE_RETENTION_DAYS",
    "LEGAL_DEPLOYMENT_JURISDICTION",
    "LEGAL_PRIVACY_SOURCES",
    "BACKUP_RETENTION_DAYS",
  ])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("GET /legal-config", () => {
  it("returns safe defaults when nothing is configured", async () => {
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
    });
  });

  it("returns admin-database values when set and no env override", async () => {
    selectResolveWith = [
      { key: "legalControllerName", value: "OpenMapX e.V." },
      { key: "legalControllerStreet", value: "Map Street 1" },
      { key: "legalControllerPostalCode", value: "10115" },
      { key: "legalControllerCity", value: "Berlin" },
      { key: "legalControllerCountry", value: "Germany" },
      { key: "legalControllerEmail", value: "legal@example.test" },
      { key: "legalControllerPhone", value: "+49 30 123456" },
      { key: "legalHostingProvider", value: "Hetzner Online GmbH" },
      { key: "legalHostingLocations", value: "Germany, Finland" },
      { key: "legalSupervisoryAuthority", value: "BfDI" },
      { key: "legalSupervisoryAuthorityUrl", value: "https://www.bfdi.bund.de" },
      { key: "legalServerLogRetentionDays", value: 14 },
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
      dsarCaseRetentionDays: 1095,
      deploymentJurisdiction: "",
      privacySources: [],
      backupRetentionDays: 30,
    });
  });

  it("lets the env var take priority over the admin-database value", async () => {
    selectResolveWith = [{ key: "legalHostingProvider", value: "Hetzner Online GmbH" }];
    vi.stubEnv("LEGAL_HOSTING_PROVIDER", "OVHcloud");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("OVHcloud");
  });

  it("lets controller env values take priority over persisted controller facts", async () => {
    selectResolveWith = [
      { key: "legalControllerName", value: "Database Controller" },
      { key: "legalControllerEmail", value: "database@example.test" },
    ];
    vi.stubEnv("LEGAL_NAME", "Environment Controller");
    vi.stubEnv("LEGAL_EMAIL", "environment@example.test");

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json()).toMatchObject({
      name: "Environment Controller",
      email: "environment@example.test",
      dataRequestEmail: "environment@example.test",
    });
  });

  it("publishes a dedicated request contact when the general legal email is empty", async () => {
    selectResolveWith = [
      { key: "legalControllerEmail", value: "" },
      { key: "legalDataRequestEmail", value: "requests@example.test" },
    ];

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json()).toMatchObject({
      email: "",
      dataRequestEmail: "requests@example.test",
    });
  });

  it("does not publish an invalid env or database address line", async () => {
    vi.stubEnv("LEGAL_STREET", "Env Street\nInjected");
    selectResolveWith = [{ key: "legalControllerStreet", value: "DB Street\nInjected" }];

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json().street).toBe("");
  });

  it("treats a blank env var as unset and falls back to the database value", async () => {
    selectResolveWith = [{ key: "legalHostingProvider", value: "Hetzner Online GmbH" }];
    vi.stubEnv("LEGAL_HOSTING_PROVIDER", "");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("Hetzner Online GmbH");
  });

  it("lets the supervisory-authority env var win over the database value", async () => {
    selectResolveWith = [{ key: "legalSupervisoryAuthority", value: "DB Authority" }];
    vi.stubEnv("LEGAL_SUPERVISORY_AUTHORITY", "Env Authority");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().supervisoryAuthority).toBe("Env Authority");
  });

  it("clamps an invalid log-retention value to the 30-day default", async () => {
    selectResolveWith = [{ key: "legalServerLogRetentionDays", value: -5 }];
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().serverLogRetentionDays).toBe(30);
  });

  it("honours a positive integer log-retention env var", async () => {
    vi.stubEnv("LEGAL_SERVER_LOG_RETENTION_DAYS", "7");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().serverLogRetentionDays).toBe(7);
  });

  it("publishes the configured backup retention for the privacy page", async () => {
    vi.stubEnv("BACKUP_RETENTION_DAYS", "14");
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().backupRetentionDays).toBe(14);
  });
});
