import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchLegalConfig } from "./legal-config";

afterEach(() => vi.unstubAllGlobals());

describe("fetchLegalConfig", () => {
  it("keeps the controller facts returned by the canonical API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            name: "Persisted Controller",
            street: "Map Street 1",
            postalCode: "10115",
            city: "Berlin",
            country: "Germany",
            email: "legal@example.test",
            phone: "+49 30 123456",
            hostingProvider: "Host GmbH",
            hostingLocations: "Germany",
            supervisoryAuthority: "Berlin DPA",
            supervisoryAuthorityUrl: "https://authority.example.test",
            serverLogRetentionDays: 14,
            dataRequestEmail: "privacy@example.test",
            dsarCaseRetentionDays: 1095,
            identityEvidenceRetentionDays: 30,
            exportArtifactRetentionHours: 168,
            deploymentJurisdiction: "DE-BE",
            privacySources: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(fetchLegalConfig()).resolves.toMatchObject({
      name: "Persisted Controller",
      street: "Map Street 1",
      postalCode: "10115",
      city: "Berlin",
      country: "Germany",
      email: "legal@example.test",
      phone: "+49 30 123456",
      dataRequestEmail: "privacy@example.test",
      deploymentJurisdiction: "DE-BE",
    });
  });

  it("returns null when the API is unavailable so callers can distinguish fallback env", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(fetchLegalConfig()).resolves.toBeNull();
  });
});
