import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("./offlineAreas", () => ({
  createOfflinePackageStorage: () => ({ list }),
}));

import { collectPrivacyDeviceData } from "./privacyDeviceData";

describe("privacy browser supplement", () => {
  beforeEach(() => {
    list.mockReset();
    list.mockResolvedValue([]);
    localStorage.clear();
    localStorage.setItem("openmapx:unitSystem", "metric");
    localStorage.setItem("openmapx:aiSearch", "false");
    localStorage.setItem("better-auth.session_token", "must-not-export");
    localStorage.setItem("openmapx-query-cache", "must-not-export");
  });

  it("exports only the explicit preference allowlist and no credentials/caches", async () => {
    const result = await collectPrivacyDeviceData(new Date("2026-09-04T00:00:00.000Z"));
    expect(result.preferences).toEqual({
      "openmapx:unitSystem": "metric",
      "openmapx:aiSearch": "false",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-export");
  });

  it("exports offline metadata but never archive bytes or error text", async () => {
    list.mockResolvedValue([
      {
        id: "omp2-" + "a".repeat(64),
        name: "Germany",
        status: "ready",
        bytesReceived: 100,
        bytesTotal: 100,
        verifiedPrefixBytes: 100,
        createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-09-02T00:00:00.000Z"),
        manifest: {
          packageId: "omp2-" + "a".repeat(64),
          coverage: { bbox: [1, 2, 3, 4], minZoom: 1, maxZoom: 12 },
        },
        lastError: { code: "secret", message: "secret" },
      },
    ]);
    const result = await collectPrivacyDeviceData();
    expect(result.offlinePackages[0]).toMatchObject({
      id: "omp2-" + "a".repeat(64),
      name: "Germany",
      bytesTotal: 100,
    });
    expect(result.offlinePackages[0]).not.toHaveProperty("lastError");
  });
});
