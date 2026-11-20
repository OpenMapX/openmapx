import { fakeHttpClient, httpStatus } from "@openmapx/integration-framework/testing";
import { describe, expect, it } from "vitest";
import { createDbBikeClient } from "./db-bike-client.js";

const bbox = { west: 9, south: 48, east: 14, north: 54 };
const EMPTY_FEED = { data: { stations: [], bikes: [], vehicle_types: [] } };

describe("createDbBikeClient", () => {
  it("keeps credentials and response caches with the client generation", async () => {
    const firstHttp = fakeHttpClient(() => EMPTY_FEED);
    const secondHttp = fakeHttpClient(() => EMPTY_FEED);
    const first = createDbBikeClient({
      clientId: "first-id",
      apiKey: "first-key",
      http: firstHttp,
    });
    const second = createDbBikeClient({
      clientId: "second-id",
      apiKey: "second-key",
      http: secondHttp,
    });

    await Promise.all([second(bbox), first(bbox)]);
    await first(bbox);

    expect(firstHttp.calls).toHaveLength(20);
    expect(secondHttp.calls).toHaveLength(20);
    expect(
      firstHttp.calls.every(
        ({ method, options }) =>
          method === "get" &&
          options?.headers?.["DB-Client-ID"] === "first-id" &&
          options.headers["DB-Api-Key"] === "first-key",
      ),
    ).toBe(true);
    expect(
      secondHttp.calls.every(
        ({ options }) =>
          options?.headers?.["DB-Client-ID"] === "second-id" &&
          options.headers["DB-Api-Key"] === "second-key",
      ),
    ).toBe(true);
    expect(firstHttp.calls[0]?.url).toMatch(
      /^https:\/\/apis\.deutschebahn\.com\/db-api-marketplace\/apis\/shared-mobility-gbfs\/v2\/de\//,
    );
  });

  it("does not make requests without a complete credential pair", async () => {
    const http = fakeHttpClient();
    const client = createDbBikeClient({ clientId: "configured-id", http });

    await expect(client(bbox)).resolves.toEqual({ stations: [], vehicles: [] });
    expect(http.calls).toEqual([]);
  });

  it("answers without the provider when DB refuses the key", async () => {
    const http = fakeHttpClient(() => httpStatus(401));
    const client = createDbBikeClient({ clientId: "id", apiKey: "rejected", http });

    await expect(client(bbox)).resolves.toEqual({ stations: [], vehicles: [] });
  });
});
