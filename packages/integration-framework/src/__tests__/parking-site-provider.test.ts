import type { ParkingSite } from "@openmapx/mobility-core/parking";
import { describe, expect, test } from "vitest";
import type { ParkingSiteProvider } from "../contracts/parking-site-provider.js";
import { createMockIntegrationContext } from "../testing/index.js";

const site: ParkingSite = {
  id: "oc:feature:de-test-parking:1",
  name: "Test garage",
  coordinates: [13.4, 52.5],
  closed: false,
  stale: false,
  areas: [],
  rates: [],
  sources: ["de-test-parking"],
  attributions: [],
};

describe("registerParkingSiteProvider", () => {
  test("registerParkingSiteProvider stores the provider under parking-sites", async () => {
    const ctx = createMockIntegrationContext();
    const provider: ParkingSiteProvider = {
      id: "test",
      coverage: { all: true },
      searchSites: async () => ({ sites: [site] }),
      getSite: async () => site,
    };
    ctx.registerParkingSiteProvider(provider);
    expect(ctx.registered.parkingSites).toEqual([provider]);
    await expect(ctx.registered.parkingSites[0]?.getSite(site.id)).resolves.toBe(site);
  });
});
