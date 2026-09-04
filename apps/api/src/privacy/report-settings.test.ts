import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePrivacyReportLegalFacts } from "./report-settings.js";

afterEach(() => vi.unstubAllEnvs());

describe("privacy report legal facts", () => {
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
});
