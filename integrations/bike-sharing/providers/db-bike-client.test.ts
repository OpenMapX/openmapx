import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import { describe, expect, it } from "vitest";
import { createDbBikeClient } from "./db-bike-client.js";

const bbox = { west: 9, south: 48, east: 14, north: 54 };

function transport(requests: Array<Record<string, string> | undefined>): MobilityHttpTransport {
  return {
    userAgent: "OpenMapX/test",
    async fetchJson<T>(_url, options) {
      requests.push(options?.headers);
      return { data: { stations: [], bikes: [], vehicle_types: [] } } as T;
    },
    async fetchText() {
      return "";
    },
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  };
}

describe("createDbBikeClient", () => {
  it("keeps credentials and response caches with the client generation", async () => {
    const firstRequests: Array<Record<string, string> | undefined> = [];
    const secondRequests: Array<Record<string, string> | undefined> = [];
    const first = createDbBikeClient({
      clientId: "first-id",
      apiKey: "first-key",
      transport: transport(firstRequests),
    });
    const second = createDbBikeClient({
      clientId: "second-id",
      apiKey: "second-key",
      transport: transport(secondRequests),
    });

    await Promise.all([second(bbox), first(bbox)]);
    await first(bbox);

    expect(firstRequests).toHaveLength(20);
    expect(secondRequests).toHaveLength(20);
    expect(
      firstRequests.every(
        (headers) =>
          headers?.["DB-Client-ID"] === "first-id" && headers["DB-Api-Key"] === "first-key",
      ),
    ).toBe(true);
    expect(
      secondRequests.every(
        (headers) =>
          headers?.["DB-Client-ID"] === "second-id" && headers["DB-Api-Key"] === "second-key",
      ),
    ).toBe(true);
  });

  it("does not make requests without a complete credential pair", async () => {
    const requests: Array<Record<string, string> | undefined> = [];
    const client = createDbBikeClient({
      clientId: "configured-id",
      transport: transport(requests),
    });

    await expect(client(bbox)).resolves.toEqual({ stations: [], vehicles: [] });
    expect(requests).toEqual([]);
  });
});
