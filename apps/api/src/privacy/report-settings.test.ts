import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrivacyLegalConfigurationError,
  resolvePrivacyReportLegalFacts,
} from "./report-settings.js";

const LEGAL_ENV = [
  "LEGAL_CONTROLLER_NAME",
  "LEGAL_CONTROLLER_STREET",
  "LEGAL_CONTROLLER_POSTAL_CODE",
  "LEGAL_CONTROLLER_CITY",
  "LEGAL_CONTROLLER_COUNTRY",
  "LEGAL_CONTROLLER_EMAIL",
  "LEGAL_CONTROLLER_PHONE",
  "LEGAL_DATA_REQUEST_EMAIL",
  "LEGAL_DEPLOYMENT_JURISDICTION",
  "LEGAL_SUPERVISORY_AUTHORITY_NAME",
  "LEGAL_SUPERVISORY_AUTHORITY_URL",
  "LEGAL_PRIVACY_SOURCES",
  "RETENTION_SERVER_LOG_DAYS",
  "RETENTION_PRIVACY_CASE_DAYS",
  "RETENTION_AUDIT_LOG_DAYS",
  "RETENTION_ADMIN_JOB_DAYS",
  "RETENTION_BACKUP_DAYS",
];

beforeEach(() => {
  for (const name of LEGAL_ENV) vi.stubEnv(name, undefined);
});
afterEach(() => vi.unstubAllEnvs());

type Row = { key: string; value: unknown };
/** The stored settings, as the resolver's keyed select reads them. */
const storedSettings = (rows: Row[]) =>
  ({ select: () => ({ from: () => ({ where: async () => rows }) }) }) as never;

const COMPLETE: Row[] = [
  { key: "legal.controller.name", value: "Controller" },
  { key: "legal.controller.street", value: "Street 1" },
  { key: "legal.controller.postalCode", value: "10115" },
  { key: "legal.controller.city", value: "Berlin" },
  { key: "legal.controller.country", value: "Germany" },
  { key: "legal.controller.email", value: "legal@example.test" },
  { key: "legal.deploymentJurisdiction", value: "DE-BE" },
  { key: "legal.supervisoryAuthority.name", value: "Berlin DPA" },
  { key: "legal.privacySources", value: [] },
];
const persistedFacts = () => storedSettings(COMPLETE);

function stubCompleteEnvironment(overrides: Record<string, string> = {}) {
  for (const [key, value] of Object.entries({
    LEGAL_CONTROLLER_NAME: "Controller",
    LEGAL_CONTROLLER_STREET: "Street 1",
    LEGAL_CONTROLLER_POSTAL_CODE: "10115",
    LEGAL_CONTROLLER_CITY: "Berlin",
    LEGAL_CONTROLLER_COUNTRY: "Germany",
    LEGAL_CONTROLLER_EMAIL: "privacy@example.test",
    LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
    LEGAL_SUPERVISORY_AUTHORITY_NAME: "Authority",
    ...overrides,
  }))
    vi.stubEnv(key, value);
}

describe("privacy report legal facts", () => {
  it("tells a configuration gap apart from a database failure", async () => {
    await expect(resolvePrivacyReportLegalFacts(storedSettings([]))).rejects.toBeInstanceOf(
      PrivacyLegalConfigurationError,
    );
    vi.stubEnv("RETENTION_BACKUP_DAYS", "0");
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).rejects.toBeInstanceOf(
      PrivacyLegalConfigurationError,
    );
    vi.stubEnv("RETENTION_BACKUP_DAYS", undefined);
    const outage = new Error("connect ECONNREFUSED");
    const unreachable = {
      select: () => ({
        from: () => ({
          where: async () => {
            throw outage;
          },
        }),
      }),
    } as never;
    await expect(resolvePrivacyReportLegalFacts(unreachable)).rejects.toBe(outage);
  });

  it("reports the configured backup retention, defaulting to 30 days", async () => {
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).resolves.toMatchObject({
      deployment: { backupRetentionDays: 30 },
    });
    vi.stubEnv("RETENTION_BACKUP_DAYS", "14");
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).resolves.toMatchObject({
      deployment: { backupRetentionDays: 14 },
    });
    vi.stubEnv("RETENTION_BACKUP_DAYS", "0");
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).rejects.toThrow(
      "RETENTION_BACKUP_DAYS",
    );
  });

  it("reports the retention periods the daily prunes enforce", async () => {
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).resolves.toMatchObject({
      deployment: {
        serverLogRetentionDays: 30,
        dsarCaseRetentionDays: 1095,
        auditLogRetentionDays: 365,
        adminJobRetentionDays: 30,
      },
    });
    vi.stubEnv("RETENTION_SERVER_LOG_DAYS", "60");
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", "730");
    vi.stubEnv("RETENTION_ADMIN_JOB_DAYS", "14");
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).resolves.toMatchObject({
      deployment: {
        serverLogRetentionDays: 60,
        auditLogRetentionDays: 730,
        adminJobRetentionDays: 14,
      },
    });
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", "abc");
    await expect(resolvePrivacyReportLegalFacts(persistedFacts())).rejects.toThrow(
      "RETENTION_AUDIT_LOG_DAYS",
    );
  });

  it("states the stored privacy case retention the cleanup enforces", async () => {
    const database = storedSettings([
      ...COMPLETE,
      { key: "retention.privacyCaseDays", value: 400 },
    ]);
    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      deployment: { dsarCaseRetentionDays: 400 },
    });
    vi.stubEnv("RETENTION_PRIVACY_CASE_DAYS", "14");
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(
      "RETENTION_PRIVACY_CASE_DAYS",
    );
  });

  it("uses persisted controller facts when deployment env is unset", async () => {
    const database = storedSettings([
      { key: "legal.controller.name", value: "Persisted Controller" },
      { key: "legal.controller.street", value: "Database Street 7" },
      { key: "legal.controller.postalCode", value: "10115" },
      { key: "legal.controller.city", value: "Berlin" },
      { key: "legal.controller.country", value: "Germany" },
      { key: "legal.controller.email", value: "legal@example.test" },
      { key: "legal.controller.phone", value: "+49 30 123456" },
      { key: "legal.dataRequestEmail", value: "" },
      { key: "legal.deploymentJurisdiction", value: "DE-BE" },
      { key: "legal.supervisoryAuthority.name", value: "Berlin DPA" },
      { key: "legal.privacySources", value: [] },
    ]);

    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      controller: {
        name: "Persisted Controller",
        address: "Database Street 7\n10115 Berlin\nGermany",
        email: "legal@example.test",
        phone: "+49 30 123456",
      },
      deployment: { jurisdiction: "DE-BE", supervisoryAuthority: "Berlin DPA" },
    });
  });

  it("accepts a dedicated request contact when no general legal email is configured", async () => {
    const database = storedSettings(
      COMPLETE.map((row) =>
        row.key === "legal.controller.email" ? { ...row, value: "" } : row,
      ).concat({ key: "legal.dataRequestEmail", value: "requests@example.test" }),
    );
    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      controller: { email: "requests@example.test" },
    });
  });

  it("resolves environment over database and the controller email as the contact fallback", async () => {
    stubCompleteEnvironment({
      LEGAL_CONTROLLER_NAME: "Configured Controller",
      LEGAL_CONTROLLER_EMAIL: "legal@example.test",
      LEGAL_DATA_REQUEST_EMAIL: "",
      LEGAL_SUPERVISORY_AUTHORITY_NAME: "Env Authority",
    });
    const database = storedSettings([
      { key: "legal.deploymentJurisdiction", value: "FR" },
      { key: "legal.supervisoryAuthority.name", value: "DB Authority" },
      { key: "legal.privacySources", value: [] },
    ]);
    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      controller: { name: "Configured Controller", email: "legal@example.test" },
      deployment: { jurisdiction: "DE-BE", supervisoryAuthority: "Env Authority" },
    });
  });

  it("fails closed when an env override is invalid even if a database value exists", async () => {
    stubCompleteEnvironment({ LEGAL_CONTROLLER_NAME: "Env Controller\nInjected" });
    const database = storedSettings([
      { key: "legal.controller.name", value: "Persisted Controller" },
      { key: "legal.privacySources", value: [] },
    ]);
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow("LEGAL_CONTROLLER_NAME");
  });

  it("fails readiness explicitly when a required deployment fact is missing", async () => {
    stubCompleteEnvironment({ LEGAL_DEPLOYMENT_JURISDICTION: "" });
    await expect(resolvePrivacyReportLegalFacts(storedSettings([]))).rejects.toThrow(
      "Missing privacy report legal configuration: deploymentJurisdiction",
    );
  });

  it.each([
    ["legal.controller.name", "   ", "legal.controller.name"],
    ["legal.controller.street", "Street 1\nHidden line", "legal.controller.street"],
    ["legal.controller.email", "not-an-email", "legal.controller.email"],
  ])("rejects invalid persisted operator fact %s", async (key, value, expected) => {
    const database = storedSettings(
      COMPLETE.map((row) => (row.key === key ? { ...row, value } : row)),
    );
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/plain,authority",
    "https://user:secret@authority.test/",
  ])("rejects an unsafe supervisory authority URL: %s", async (unsafeUrl) => {
    stubCompleteEnvironment({ LEGAL_SUPERVISORY_AUTHORITY_URL: unsafeUrl });
    await expect(resolvePrivacyReportLegalFacts(storedSettings([]))).rejects.toThrow(
      "LEGAL_SUPERVISORY_AUTHORITY_URL",
    );
  });

  it.each([
    ["environment", "{not-json", "LEGAL_PRIVACY_SOURCES"],
    ["database", [{ id: "missing-required-contract-fields" }], "legal.privacySources"],
  ])("fails closed for malformed privacy sources from %s", async (source, malformed, expected) => {
    stubCompleteEnvironment({
      LEGAL_PRIVACY_SOURCES: source === "environment" ? String(malformed) : "",
    });
    const database = storedSettings(
      source === "database" ? [{ key: "legal.privacySources", value: malformed }] : [],
    );
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(expected);
  });
});
