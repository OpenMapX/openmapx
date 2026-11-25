import { STORAGE_KEYS } from "@openmapx/core";
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
    localStorage.setItem(STORAGE_KEYS.unitSystem.key, "metric");
    localStorage.setItem(STORAGE_KEYS.aiSearch.key, "false");
    localStorage.setItem(STORAGE_KEYS.navigation3d.key, "true");
    localStorage.setItem(STORAGE_KEYS.globeLighting.key, "false");
    localStorage.setItem(STORAGE_KEYS.searchHistoryEnabled.key, "false");
    localStorage.setItem("better-auth.session_token", "must-not-export");
    localStorage.setItem(STORAGE_KEYS.queryCache.key, "must-not-export");
    localStorage.setItem(STORAGE_KEYS.lastMapView.key, "must-not-export");
    localStorage.setItem(STORAGE_KEYS.crowdGrant.key, "must-not-export");
  });

  it("exports only the declared preference keys and no credentials/caches", async () => {
    const result = await collectPrivacyDeviceData(new Date("2026-09-04T00:00:00.000Z"));
    expect(result.preferences).toEqual({
      "openmapx:settings:unit-system": "metric",
      "openmapx:search:ai-search": "false",
      "openmapx:navigation:3d": "true",
      "openmapx:map:globe-lighting": "false",
      "openmapx:search:history-enabled": "false",
    });
    expect(JSON.stringify(result)).not.toContain("must-not-export");
  });

  it("exports offline metadata but never archive bytes or error text", async () => {
    list.mockResolvedValue([
      {
        id: `omp2-${"a".repeat(64)}`,
        name: "Germany",
        status: "ready",
        bytesReceived: 100,
        bytesTotal: 100,
        verifiedPrefixBytes: 100,
        createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
        updatedAt: Date.parse("2026-09-02T00:00:00.000Z"),
        manifest: {
          packageId: `omp2-${"a".repeat(64)}`,
          coverage: { bbox: [1, 2, 3, 4], minZoom: 1, maxZoom: 12 },
        },
        lastError: { code: "secret", message: "secret" },
      },
    ]);
    const result = await collectPrivacyDeviceData();
    expect(result.offlinePackages[0]).toMatchObject({
      id: `omp2-${"a".repeat(64)}`,
      name: "Germany",
      bytesTotal: 100,
    });
    expect(result.offlinePackages[0]).not.toHaveProperty("lastError");
  });
});
