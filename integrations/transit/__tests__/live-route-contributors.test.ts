import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { expect, it } from "vitest";
import { setup } from "../index";

it("preserves distinct same-source required notices in the actual live-route response", async () => {
  const vehicle = { sourceId: "feed", name: "Feed", attributionText: "Vehicle required notice" };
  const alert = { sourceId: "feed", name: "Feed", attributionText: "Alert required notice" };
  const ctx = createMockIntegrationContext({ id: "transit" });
  const provider = {
    id: "feed",
    prefix: "feed:",
    priority: 1,
    getVehiclePositions: async () => ({
      data: [{ id: "vehicle", contributors: [vehicle] }],
      attributions: [vehicle],
      freshness: freshnessNow(),
    }),
    getAlertsForRoute: async () => ({
      data: [{ id: "alert", contributors: [alert] }],
      attributions: [alert],
      freshness: freshnessNow(),
    }),
  };
  ctx.getIntegrationsByDomain = () =>
    [
      {
        id: "adapter",
        manifest: { dataSources: [] },
        providers: new Map([["transit", [provider]]]),
      },
    ] as never;
  setup(ctx);
  const route = ctx.registered.routes.find((row) => row.path === "/routes/:id/live");
  let sent: unknown;
  await route?.handler(
    { params: { id: "feed:line" }, query: {} } as never,
    {
      header() {},
      send(data: unknown) {
        sent = JSON.parse(JSON.stringify(data));
      },
    } as never,
  );
  expect(sent).toMatchObject({
    attributions: [vehicle, alert],
    data: { vehicles: [{ contributors: [vehicle] }], alerts: [{ contributors: [alert] }] },
  });
});
