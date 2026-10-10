import type { ChargingSite } from "@openmapx/mobility-core/ev-charging";
import { describe, expect, test } from "vitest";
import type { ChargingSiteProvider } from "../contracts/charging-site-provider.js";
import { createMockIntegrationContext } from "../testing/index.js";

const site: ChargingSite = {
  id: "oc:feature:de-test-charging:1",
  name: "Test chargers",
  coordinates: [13.4, 52.5],
  payment: [],
  authentication: [],
  closed: false,
  planned: false,
  evses: [],
  tariffs: [],
  sources: ["de-test-charging"],
  attributions: [],
};

describe("registerChargingSiteProvider", () => {
  test("registerChargingSiteProvider stores the provider under charging-sites", async () => {
    const ctx = createMockIntegrationContext();
    const provider: ChargingSiteProvider = {
      id: "test",
      coverage: { all: true },
      searchSites: async () => ({ sites: [site] }),
      getSite: async () => site,
    };
    ctx.registerChargingSiteProvider(provider);
    expect(ctx.registered.chargingSites).toEqual([provider]);
    await expect(ctx.registered.chargingSites[0]?.getSite(site.id)).resolves.toBe(site);
  });
});
