import { describe, expect, it } from "vitest";
import { createTransitMotisInstances } from "../instances.js";

// MOTIS honours only the first occurrence of a repeated query param, so a
// multi-mode `transitModes` allow-list must be sent comma-joined in a single
// param. The client-fetch default explodes arrays into repeated params, which
// silently dropped every mode after the first (breaking the Deutschlandticket
// filter). These tests pin the comma-joined serialisation.
describe("transit-MOTIS instances", () => {
  async function captureUrl(
    instance: ReturnType<typeof createTransitMotisInstances>["transitousInstance"],
  ): Promise<string> {
    let capturedUrl = "";
    const mockFetch = (input: Request): Promise<Response> => {
      capturedUrl = input.url;
      return Promise.resolve(
        new Response(JSON.stringify({ itineraries: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    };
    await instance.client.get({
      url: "/api/v1/plan",
      query: { transitModes: ["REGIONAL_RAIL", "TRAM", "BUS"] },
      fetch: mockFetch as unknown as typeof fetch,
    });
    return capturedUrl;
  }

  it("constructs local, reachability, and hosted clients from one resolved configuration", async () => {
    const instances = createTransitMotisInstances({
      localUrl: "https://local.example",
      transitousUrl: "https://hosted.example",
    });

    expect(instances.motisLocalInstance.client).not.toBe(
      instances.motisLocalReachabilityInstance.client,
    );
    expect(instances.motisLocalInstance).toMatchObject({ prefix: "ms:", provider: "ms" });
    expect(instances.transitousInstance).toMatchObject({ prefix: "mo:", provider: "mo" });
    await expect(captureUrl(instances.motisLocalInstance)).resolves.toContain(
      "https://local.example/api/v1/plan",
    );
    await expect(captureUrl(instances.transitousInstance)).resolves.toContain(
      "https://hosted.example/api/v1/plan",
    );
  });
});
