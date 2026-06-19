import { describe, expect, it } from "vitest";
import { motisLocalInstance, transitousInstance } from "../instances.js";

// MOTIS honours only the first occurrence of a repeated query param, so a
// multi-mode `transitModes` allow-list must be sent comma-joined in a single
// param. The client-fetch default explodes arrays into repeated params, which
// silently dropped every mode after the first (breaking the Deutschlandticket
// filter). These tests pin the comma-joined serialisation.
describe("MOTIS client query serialization", () => {
  async function captureUrl(instance: typeof transitousInstance): Promise<string> {
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

  it("serializes array params comma-joined for the Transitous client", async () => {
    const url = await captureUrl(transitousInstance);
    expect(url).toContain("transitModes=REGIONAL_RAIL,TRAM,BUS");
    expect(url.match(/transitModes=/g)).toHaveLength(1);
  });

  it("serializes array params comma-joined for the local MOTIS client", async () => {
    const url = await captureUrl(motisLocalInstance);
    expect(url).toContain("transitModes=REGIONAL_RAIL,TRAM,BUS");
    expect(url.match(/transitModes=/g)).toHaveLength(1);
  });
});
