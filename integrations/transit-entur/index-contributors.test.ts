import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { expect, it, vi } from "vitest";

vi.mock("./provider.js", () => ({
  setEnturTransitConfig: () => {},
  getStopInfrastructure: async () => ({
    sourceId: "NSR:StopPlace:337",
    canonicalStop: { id: "entur:337" },
    focusLevel: "parent_stop",
    platforms: [{ id: "entur:quay" }],
  }),
  getDepartures: async () => [{ tripId: "entur:trip" }],
  getVehiclePositions: async () => [{ id: "entur:vehicle" }],
}));

import { setup } from "./index";

it("captures exact API receipts without mistaking an NSR entity id for its supplier", async () => {
  const ctx = createMockIntegrationContext({
    id: "transit-entur",
    manifest: {
      dataSources: ["entur-nsr", "entur-journey-planner", "entur-vehicles"].map((sourceId) => ({
        sourceId,
        name: sourceId,
        url: "https://entur.no",
        licensing: licensingFromDeclaration("NLOD", undefined, sourceId),
        providerCountry: "NO",
        providerPrivacyUrl: "https://entur.no",
      })),
    } as never,
  });
  setup(ctx);
  const provider = ctx.registered.transit[0];
  const infra = await provider.getStopInfrastructure?.("entur:337");
  expect(infra?.data?.contributors?.map((receipt) => receipt.sourceId)).toEqual(["entur-nsr"]);
  expect(infra?.data?.platforms[0].contributors?.map((receipt) => receipt.sourceId)).toEqual([
    "entur-nsr",
  ]);
  const departures = await provider.getDepartures?.("entur:337", 60);
  expect(departures?.data[0].contributors?.map((receipt) => receipt.sourceId)).toEqual([
    "entur-journey-planner",
  ]);
  const vehicles = await provider.getVehiclePositions?.("entur:line");
  expect(vehicles?.data[0].contributors?.map((receipt) => receipt.sourceId)).toEqual([
    "entur-vehicles",
  ]);
});
