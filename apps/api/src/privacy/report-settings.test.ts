import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePrivacyReportLegalFacts } from "./report-settings.js";

afterEach(() => vi.unstubAllEnvs());

describe("privacy report legal facts", () => {
  it("uses persisted controller facts when deployment env is unset", async () => {
    for (const name of [
      "LEGAL_NAME",
      "LEGAL_STREET",
      "LEGAL_POSTAL_CODE",
      "LEGAL_CITY",
      "LEGAL_COUNTRY",
      "LEGAL_EMAIL",
      "LEGAL_PHONE",
      "LEGAL_DATA_REQUEST_EMAIL",
      "LEGAL_DEPLOYMENT_JURISDICTION",
      "LEGAL_SUPERVISORY_AUTHORITY",
    ])
      vi.stubEnv(name, "");
    const database = {
      select: () => ({
        from: async () => [
          { key: "legalControllerName", value: "Persisted Controller" },
          { key: "legalControllerStreet", value: "Database Street 7" },
          { key: "legalControllerPostalCode", value: "10115" },
          { key: "legalControllerCity", value: "Berlin" },
          { key: "legalControllerCountry", value: "Germany" },
          { key: "legalControllerEmail", value: "legal@example.test" },
          { key: "legalControllerPhone", value: "+49 30 123456" },
          { key: "legalDataRequestEmail", value: "" },
          { key: "legalDeploymentJurisdiction", value: "DE-BE" },
          { key: "legalSupervisoryAuthority", value: "Berlin DPA" },
          { key: "legalPrivacySources", value: [] },
        ],
      }),
    } as never;

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
    for (const name of [
      "LEGAL_NAME",
      "LEGAL_STREET",
      "LEGAL_POSTAL_CODE",
      "LEGAL_CITY",
      "LEGAL_COUNTRY",
      "LEGAL_EMAIL",
      "LEGAL_DATA_REQUEST_EMAIL",
      "LEGAL_DEPLOYMENT_JURISDICTION",
      "LEGAL_SUPERVISORY_AUTHORITY",
    ])
      vi.stubEnv(name, "");
    const database = {
      select: () => ({
        from: async () => [
          { key: "legalControllerName", value: "Controller" },
          { key: "legalControllerStreet", value: "Street 1" },
          { key: "legalControllerPostalCode", value: "10115" },
          { key: "legalControllerCity", value: "Berlin" },
          { key: "legalControllerCountry", value: "Germany" },
          { key: "legalControllerEmail", value: "" },
          { key: "legalDataRequestEmail", value: "requests@example.test" },
          { key: "legalDeploymentJurisdiction", value: "DE-BE" },
          { key: "legalSupervisoryAuthority", value: "Berlin DPA" },
          { key: "legalPrivacySources", value: [] },
        ],
      }),
    } as never;

    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      controller: { email: "requests@example.test" },
    });
  });

  it("resolves environment over database and LEGAL_EMAIL as the contact fallback", async () => {
    vi.stubEnv("LEGAL_NAME", "Configured Controller");
    vi.stubEnv("LEGAL_STREET", "Street 1");
    vi.stubEnv("LEGAL_POSTAL_CODE", "10115");
    vi.stubEnv("LEGAL_CITY", "Berlin");
    vi.stubEnv("LEGAL_COUNTRY", "Germany");
    vi.stubEnv("LEGAL_EMAIL", "legal@example.test");
    vi.stubEnv("LEGAL_DATA_REQUEST_EMAIL", "");
    vi.stubEnv("LEGAL_DEPLOYMENT_JURISDICTION", "DE-BE");
    vi.stubEnv("LEGAL_SUPERVISORY_AUTHORITY", "Env Authority");
    const database = {
      select: () => ({
        from: async () => [
          { key: "legalDeploymentJurisdiction", value: "FR" },
          { key: "legalSupervisoryAuthority", value: "DB Authority" },
          { key: "legalPrivacySources", value: [] },
        ],
      }),
    } as never;
    await expect(resolvePrivacyReportLegalFacts(database)).resolves.toMatchObject({
      controller: { name: "Configured Controller", email: "legal@example.test" },
      deployment: { jurisdiction: "DE-BE", supervisoryAuthority: "Env Authority" },
    });
  });

  it("fails closed when an env override is invalid even if a database value exists", async () => {
    vi.stubEnv("LEGAL_NAME", "Env Controller\nInjected");
    vi.stubEnv("LEGAL_STREET", "Street 1");
    vi.stubEnv("LEGAL_POSTAL_CODE", "10115");
    vi.stubEnv("LEGAL_CITY", "Berlin");
    vi.stubEnv("LEGAL_COUNTRY", "Germany");
    vi.stubEnv("LEGAL_EMAIL", "legal@example.test");
    vi.stubEnv("LEGAL_DEPLOYMENT_JURISDICTION", "DE-BE");
    vi.stubEnv("LEGAL_SUPERVISORY_AUTHORITY", "Berlin DPA");
    const database = {
      select: () => ({
        from: async () => [
          { key: "legalControllerName", value: "Persisted Controller" },
          { key: "legalPrivacySources", value: [] },
        ],
      }),
    } as never;

    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow("controllerName");
  });

  it("fails readiness explicitly when a required deployment fact is missing", async () => {
    for (const [key, value] of Object.entries({
      LEGAL_NAME: "Controller",
      LEGAL_STREET: "Street 1",
      LEGAL_POSTAL_CODE: "10115",
      LEGAL_CITY: "Berlin",
      LEGAL_COUNTRY: "Germany",
      LEGAL_EMAIL: "privacy@example.test",
      LEGAL_DEPLOYMENT_JURISDICTION: "",
      LEGAL_SUPERVISORY_AUTHORITY: "Authority",
    }))
      vi.stubEnv(key, value);
    const database = { select: () => ({ from: async () => [] }) } as never;
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(
      "Missing privacy report legal configuration: deploymentJurisdiction",
    );
  });

  it.each([
    ["legalControllerName", "   ", "controllerName"],
    ["legalControllerStreet", "Street 1\nHidden line", "controllerStreet"],
    ["legalControllerEmail", "not-an-email", "controllerEmail"],
  ])("rejects invalid persisted operator fact %s", async (key, value, expectedField) => {
    for (const name of [
      "LEGAL_NAME",
      "LEGAL_STREET",
      "LEGAL_POSTAL_CODE",
      "LEGAL_CITY",
      "LEGAL_COUNTRY",
      "LEGAL_EMAIL",
      "LEGAL_DATA_REQUEST_EMAIL",
      "LEGAL_DEPLOYMENT_JURISDICTION",
      "LEGAL_SUPERVISORY_AUTHORITY",
    ])
      vi.stubEnv(name, "");
    const rows = [
      { key: "legalControllerName", value: "Controller" },
      { key: "legalControllerStreet", value: "Street 1" },
      { key: "legalControllerPostalCode", value: "10115" },
      { key: "legalControllerCity", value: "Berlin" },
      { key: "legalControllerCountry", value: "Germany" },
      { key: "legalControllerEmail", value: "privacy@example.test" },
      { key: "legalDeploymentJurisdiction", value: "DE-BE" },
      { key: "legalSupervisoryAuthority", value: "Authority" },
      { key: "legalPrivacySources", value: [] },
    ].map((row) => (row.key === key ? { ...row, value } : row));
    const database = { select: () => ({ from: async () => rows }) } as never;

    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(expectedField);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/plain,authority",
    "https://user:secret@authority.test/",
  ])("rejects an unsafe supervisory authority URL: %s", async (unsafeUrl) => {
    for (const [key, value] of Object.entries({
      LEGAL_NAME: "Controller",
      LEGAL_STREET: "Street 1",
      LEGAL_POSTAL_CODE: "10115",
      LEGAL_CITY: "Berlin",
      LEGAL_COUNTRY: "Germany",
      LEGAL_EMAIL: "privacy@example.test",
      LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
      LEGAL_SUPERVISORY_AUTHORITY: "Authority",
      LEGAL_SUPERVISORY_AUTHORITY_URL: unsafeUrl,
    }))
      vi.stubEnv(key, value);
    const database = { select: () => ({ from: async () => [] }) } as never;
    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow(
      "Invalid privacy report legal configuration: supervisoryAuthorityUrl",
    );
  });

  it.each([
    ["environment", "{not-json"],
    ["database", [{ id: "missing-required-contract-fields" }]],
  ])("fails closed for malformed privacy sources from %s", async (source, malformed) => {
    for (const [key, value] of Object.entries({
      LEGAL_NAME: "Controller",
      LEGAL_STREET: "Street 1",
      LEGAL_POSTAL_CODE: "10115",
      LEGAL_CITY: "Berlin",
      LEGAL_COUNTRY: "Germany",
      LEGAL_EMAIL: "privacy@example.test",
      LEGAL_DEPLOYMENT_JURISDICTION: "DE-BE",
      LEGAL_SUPERVISORY_AUTHORITY: "Authority",
      LEGAL_PRIVACY_SOURCES: source === "environment" ? String(malformed) : "",
    }))
      vi.stubEnv(key, value);
    const database = {
      select: () => ({
        from: async () =>
          source === "database" ? [{ key: "legalPrivacySources", value: malformed }] : [],
      }),
    } as never;

    await expect(resolvePrivacyReportLegalFacts(database)).rejects.toThrow("privacySources");
  });
});
