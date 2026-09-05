import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockAdminSession } from "../../test/auth.js";

// The public /legal-config route reuses resolveSettings() from admin-settings,
// so importing it pulls in that module's import-time dependencies. Mock the
// same surface the admin-settings test does so nothing reaches a real DB,
// mailer, or auth backend at module load.
const fakeSession = mockAdminSession();
vi.mock("../../utils/require-admin.js", () => ({
  requireAdmin: vi.fn().mockResolvedValue(fakeSession),
  getAdminSession: vi.fn().mockReturnValue(fakeSession),
  tryAdminSession: vi.fn().mockResolvedValue(fakeSession),
}));
vi.mock("../../utils/audit-log.js", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/data-use-policy.js", () => ({
  invalidateDataUsePolicy: vi.fn(),
  refreshDataUsePolicy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/app-logger.js", () => ({
  appLogger: { add: vi.fn(), getEntries: vi.fn(), getSources: vi.fn() },
}));
vi.mock("../../utils/email.js", () => ({
  loadEmailConfig: vi.fn(),
  sendViaEmailLabs: vi.fn(),
  sendViaLettermint: vi.fn(),
  sendViaSmtp: vi.fn(),
}));
vi.mock("../../utils/rate-limit.js", () => ({
  emailTestLimit: { preHandler: () => vi.fn() },
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

afterAll(() => app.close());

beforeEach(() => {
  selectResolveWith = [];
  delete process.env.LEGAL_NAME;
  delete process.env.LEGAL_STREET;
  delete process.env.LEGAL_POSTAL_CODE;
  delete process.env.LEGAL_CITY;
  delete process.env.LEGAL_COUNTRY;
  delete process.env.LEGAL_EMAIL;
  delete process.env.LEGAL_PHONE;
  delete process.env.LEGAL_HOSTING_PROVIDER;
  delete process.env.LEGAL_HOSTING_LOCATIONS;
  delete process.env.LEGAL_SUPERVISORY_AUTHORITY;
  delete process.env.LEGAL_SERVER_LOG_RETENTION_DAYS;
});
afterEach(() => vi.clearAllMocks());

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
      identityEvidenceRetentionDays: 30,
      exportArtifactRetentionHours: 168,
      deploymentJurisdiction: "",
      privacySources: [],
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
      identityEvidenceRetentionDays: 30,
      exportArtifactRetentionHours: 168,
      deploymentJurisdiction: "",
      privacySources: [],
    });
  });

  it("lets the env var take priority over the admin-database value", async () => {
    selectResolveWith = [{ key: "legalHostingProvider", value: "Hetzner Online GmbH" }];
    process.env.LEGAL_HOSTING_PROVIDER = "OVHcloud";
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("OVHcloud");
  });

  it("lets controller env values take priority over persisted controller facts", async () => {
    selectResolveWith = [
      { key: "legalControllerName", value: "Database Controller" },
      { key: "legalControllerEmail", value: "database@example.test" },
    ];
    process.env.LEGAL_NAME = "Environment Controller";
    process.env.LEGAL_EMAIL = "environment@example.test";

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
    process.env.LEGAL_STREET = "Env Street\nInjected";
    selectResolveWith = [{ key: "legalControllerStreet", value: "DB Street\nInjected" }];

    const res = await app.inject({ method: "GET", url: "/legal-config" });

    expect(res.json().street).toBe("");
  });

  it("treats a blank env var as unset and falls back to the database value", async () => {
    selectResolveWith = [{ key: "legalHostingProvider", value: "Hetzner Online GmbH" }];
    process.env.LEGAL_HOSTING_PROVIDER = "";
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().hostingProvider).toBe("Hetzner Online GmbH");
  });

  it("lets the supervisory-authority env var win over the database value", async () => {
    selectResolveWith = [{ key: "legalSupervisoryAuthority", value: "DB Authority" }];
    process.env.LEGAL_SUPERVISORY_AUTHORITY = "Env Authority";
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().supervisoryAuthority).toBe("Env Authority");
  });

  it("clamps an invalid log-retention value to the 30-day default", async () => {
    selectResolveWith = [{ key: "legalServerLogRetentionDays", value: -5 }];
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().serverLogRetentionDays).toBe(30);
  });

  it("honours a positive integer log-retention env var", async () => {
    process.env.LEGAL_SERVER_LOG_RETENTION_DAYS = "7";
    const res = await app.inject({ method: "GET", url: "/legal-config" });
    expect(res.json().serverLogRetentionDays).toBe(7);
  });
});
