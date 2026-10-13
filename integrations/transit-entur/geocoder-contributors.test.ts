import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, expect, it, vi } from "vitest";
import { setup } from "./index";
import manifest from "./manifest.json";

afterEach(() => vi.unstubAllGlobals());

it("credits the actual autocomplete HTTP source before retaining its stop row", async () => {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    requested.push(String(input));
    return Response.json({
      features: [
        {
          geometry: { coordinates: [10.7, 59.9] },
          properties: { id: "NSR:StopPlace:337", name: "Oslo S", layer: "venue" },
        },
      ],
    });
  });
  const ctx = createMockIntegrationContext({ id: "transit-entur", manifest: manifest as never });
  setup(ctx);
  const result = await ctx.registered.transit[0].searchStopsByName?.("Oslo", 10);
  expect(requested).toHaveLength(1);
  expect(new URL(requested[0]).pathname).toBe("/geocoder/v1/autocomplete");
  expect(new URL(requested[0]).searchParams.get("text")).toBe("Oslo");
  expect(result?.data).toHaveLength(1);
  expect(result?.data[0].contributors?.map((r) => r.sourceId)).toEqual(["entur-geocoder"]);
  const retained = result?.data[0];
  const geocoder = manifest.dataSources.find((source) => source.sourceId === "entur-geocoder");
  if (!geocoder) throw new Error("Missing geocoder declaration");
  const originalName = geocoder.name;
  geocoder.name = "Later manifest";
  try {
    expect(retained?.contributors?.[0].name).toBe(originalName);
  } finally {
    geocoder.name = originalName;
  }
});
