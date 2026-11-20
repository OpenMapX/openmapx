import type { RentalsResponse } from "@motis-project/motis-client";
import { describe, expect, it } from "vitest";
import type { CacheClient } from "../src/cache.js";
import type { MobilityHttpRequestOptions, MobilityHttpTransport } from "../src/json-transport.js";
import type { MotisRentalsHttp } from "../src/motis-rentals.js";
import { createSharedMobilityRuntime } from "../src/shared-mobility-runtime.js";

const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };

function cacheClient() {
  const values = new Map<string, unknown>();
  const cache: CacheClient = {
    async get<T>(key: string) {
      return (values.get(key) as T | undefined) ?? null;
    },
    async set(key, value) {
      values.set(key, value);
    },
    async del(key) {
      values.delete(key);
    },
    async withCache<T>(key: string, _ttl: number, load: (signal: AbortSignal) => Promise<T>) {
      const cached = values.get(key) as T | undefined;
      if (cached !== undefined) return cached;
      const value = await load(new AbortController().signal);
      values.set(key, value);
      return value;
    },
  };
  return { cache, values };
}

function transport(name: string, requests: Array<{ url: string; userAgent?: string }>) {
  const instance: MobilityHttpTransport = {
    userAgent: `OpenMapX/${name}`,
    async fetchText(url, options) {
      requests.push({ url, userAgent: options?.headers?.["User-Agent"] });
      return [
        "Country Code,Name,Location,System ID,URL,Auto-Discovery URL",
        `DE,${name},Berlin,${name},https://${name}.example,https://${name}.example/gbfs.json`,
      ].join("\n");
    },
    async fetchJson<T>(url: string, options?: MobilityHttpRequestOptions) {
      requests.push({ url, userAgent: options?.headers?.["User-Agent"] });
      if (url.includes("manifest.json")) {
        return { data: { datasets: [] } } as T;
      }
      if (url.includes("/reverse")) {
        return { address: { city: name } } as T;
      }
      throw new Error(`unexpected ${name} request: ${url}`);
    },
    hostMatchesAllowlist: () => false,
    privateFeedHostAllowlist: () => [],
  };
  return instance;
}

function rentals(providerId: string): RentalsResponse {
  return {
    providerGroups: [],
    providers: [
      {
        id: providerId,
        name: providerId,
        groupId: "",
        operator: providerId,
        url: "",
        purchaseUrl: "",
        color: "",
        bbox: [13.3, 52.4, 13.5, 52.6],
        vehicleTypes: [],
        formFactors: [],
        defaultRestrictions: {
          vehicleTypeIdxs: [],
          rideStartAllowed: true,
          rideEndAllowed: true,
          rideThroughAllowed: true,
        },
        globalGeofencingRules: [],
      },
    ],
    stations: [],
    vehicles: [],
    zones: [],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return { status, body: JSON.stringify(value) };
}

/** A rental client answering each request URL (with its query) from `answer`. */
function rentalsHttp(
  answer: (
    url: string,
  ) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): MotisRentalsHttp {
  return {
    async getText(url, options) {
      const requestUrl = new URL(url);
      for (const [name, value] of Object.entries(options.params)) {
        requestUrl.searchParams.set(name, String(value));
      }
      const response = await answer(requestUrl.toString());
      return response.status >= 200 && response.status < 300 ? response : { ...response, body: "" };
    },
  };
}

describe("createSharedMobilityRuntime", () => {
  it("keeps concurrent caches, endpoints, clients, source maps, and decisions isolated", async () => {
    const firstCache = cacheClient();
    const secondCache = cacheClient();
    const firstRequests: Array<{ url: string; userAgent?: string }> = [];
    const secondRequests: Array<{ url: string; userAgent?: string }> = [];
    const motisRequests: string[] = [];
    const firstDecisions: string[] = [];
    const secondDecisions: string[] = [];

    const http = rentalsHttp((url) => {
      motisRequests.push(url);
      return jsonResponse(
        rentals(url.includes("first-motis") ? "first-provider" : "second-provider"),
      );
    });

    const first = createSharedMobilityRuntime({
      cache: firstCache.cache,
      transport: transport("first", firstRequests),
      http,
      motisUrl: "https://first-motis.example",
      transitousUrl: "https://first-transitous.example",
      nominatimUrl: "https://first-nominatim.example",
      rentalSourceIndex: [{ providerId: "first-provider", sourceId: "first-source" }],
      onDecision: (category) => firstDecisions.push(category),
    });
    const second = createSharedMobilityRuntime({
      cache: secondCache.cache,
      transport: transport("second", secondRequests),
      http,
      motisUrl: "https://second-motis.example",
      transitousUrl: "https://second-transitous.example",
      nominatimUrl: "https://second-nominatim.example",
      rentalSourceIndex: [{ providerId: "second-provider", sourceId: "second-source" }],
      onDecision: (category) => secondDecisions.push(category),
    });

    const [firstCatalog, secondCatalog, firstCity, secondCity, firstRental, secondRental] =
      await Promise.all([
        first.loadCatalog(),
        second.loadCatalog(),
        first.reverseGeocodeCity(52.5, 13.4),
        second.reverseGeocodeCity(52.5, 13.4),
        first.fetchMotisRentals([bbox.west, bbox.south, bbox.east, bbox.north]),
        second.fetchMotisRentals([bbox.west, bbox.south, bbox.east, bbox.north]),
      ]);

    await Promise.all([
      first.orchestrate(bbox, {
        category: "bike",
        motisFormFactors: ["bicycle"],
        adapters: [],
      }),
      second.orchestrate(bbox, {
        category: "car",
        motisFormFactors: ["car"],
        adapters: [],
      }),
    ]);

    expect(firstCatalog.some((entry) => entry.systemId === "first")).toBe(true);
    expect(firstCatalog.some((entry) => entry.systemId === "second")).toBe(false);
    expect(secondCatalog.some((entry) => entry.systemId === "second")).toBe(true);
    expect(secondCatalog.some((entry) => entry.systemId === "first")).toBe(false);
    expect(firstCity).toBe("first");
    expect(secondCity).toBe("second");
    expect(firstRental.providers[0]?.sourceId).toBe("first-source");
    expect(secondRental.providers[0]?.sourceId).toBe("second-source");
    expect(firstRequests.every((request) => request.userAgent === "OpenMapX/first")).toBe(true);
    expect(secondRequests.every((request) => request.userAgent === "OpenMapX/second")).toBe(true);
    expect(motisRequests.some((url) => url.includes("first-motis.example"))).toBe(true);
    expect(motisRequests.some((url) => url.includes("second-motis.example"))).toBe(true);
    expect(firstCache.values.has("shared-mobility:gbfs-catalog")).toBe(true);
    expect(secondCache.values.has("shared-mobility:gbfs-catalog")).toBe(true);
    expect(firstDecisions).toEqual(["bike"]);
    expect(secondDecisions).toEqual(["car"]);
  });

  it("keeps the local MOTIS circuit breaker inside its owning runtime", async () => {
    const requests: string[] = [];
    const http = rentalsHttp((url) => {
      requests.push(url);
      if (url.includes("broken-local")) return jsonResponse({ message: "down" }, 503);
      return jsonResponse(rentals(url.includes("healthy-local") ? "healthy" : "hosted"));
    });
    const broken = createSharedMobilityRuntime({
      cache: cacheClient().cache,
      transport: transport("broken", []),
      http,
      motisUrl: "https://broken-local.example",
      transitousUrl: "https://broken-hosted.example",
    });
    const healthy = createSharedMobilityRuntime({
      cache: cacheClient().cache,
      transport: transport("healthy", []),
      http,
      motisUrl: "https://healthy-local.example",
      transitousUrl: "https://healthy-hosted.example",
    });

    await broken.fetchMotisRentals([bbox.west, bbox.south, bbox.east, bbox.north]);
    await broken.fetchMotisRentals([bbox.west, bbox.south, bbox.east, bbox.north]);
    const healthySnapshot = await healthy.fetchMotisRentals([
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
    ]);

    expect(healthySnapshot.origin).toBe("motis-local");
    expect(requests.filter((url) => url.includes("healthy-local.example"))).toHaveLength(1);
    expect(requests.some((url) => url.includes("healthy-hosted.example"))).toBe(false);
  });
});
