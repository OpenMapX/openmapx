import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
}

function emptyResponse(status = 200): Response {
  return new Response(null, { status });
}

function getRequest(input: unknown, init?: RequestInit): Request {
  if (input instanceof Request) return input;
  if (typeof input === "string" || input instanceof URL) {
    return new Request(input, init);
  }
  throw new Error("Expected fetch to receive a Request-compatible input.");
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("@hey-api/client-fetch runtime integrations", () => {
  it("does not force JSON content type for FormData bodies", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      expect(request.url).toBe("https://api.example/upload");
      expect(request.headers.get("Content-Type")).toMatch(/^multipart\/form-data; boundary=/);
      const formData = await request.formData();
      expect(formData.get("name")).toBe("Logo");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createClient, formDataBodySerializer } = await import("@hey-api/client-fetch");
    const client = createClient({ baseUrl: "https://api.example" });

    await client.post({
      url: "/upload",
      body: { name: "Logo" },
      ...formDataBodySerializer,
    });
  });

  it("serializes label-style path parameters without encoding the leading dot", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      expect(request.url).toBe("https://api.example/pets/.cat%2Fdog");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createClient } = await import("@hey-api/client-fetch");
    const client = createClient({ baseUrl: "https://api.example" });

    await client.get({
      url: "/pets/{.petId}",
      path: { petId: "cat/dog" },
    });
  });

  it("preserves absolute request URLs and appends query parameters correctly", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      const url = new URL(request.url);
      expect(url.origin).toBe("https://override.example");
      expect(url.pathname).toBe("/v1/items");
      expect(url.searchParams.get("existing")).toBe("1");
      expect(url.searchParams.get("q")).toBe("two");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createClient } = await import("@hey-api/client-fetch");
    const client = createClient({ baseUrl: "https://base.example" });

    await client.get({
      url: "https://override.example/v1/items?existing=1",
      query: { q: "two" },
    });
  });

  it("returns data: undefined on non-throwing error results", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "bad" }, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const { createClient } = await import("@hey-api/client-fetch");
    const client = createClient({ baseUrl: "https://api.example" });

    const result = await client.get<{ ok: true }, { message: string }>({
      url: "/fail",
    });

    expect(result).toMatchObject({
      data: undefined,
      error: { message: "bad" },
    });
  });

  it("works with transit-motis instances and the generated MOTIS SDK", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      const url = new URL(request.url);

      if (url.pathname === "/api/v6/map/stops") {
        expect(url.searchParams.get("min")).toBe("0,0");
        expect(url.searchParams.get("max")).toBe("0.1,0.1");
        return jsonResponse([]);
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [{ createTransitMotisInstances }, motis] = await Promise.all([
      import("@integrations/transit-motis/instances.js"),
      import("@motis-project/motis-client"),
    ]);
    const { motisLocalInstance, transitousInstance } = createTransitMotisInstances({
      localUrl: "http://local.example",
      transitousUrl: "https://cloud.example",
      transitousUserAgent: "OpenMapX-Test/1.0",
    });

    const cloud = await motis.stops({
      client: transitousInstance.client,
      query: { max: "0.1,0.1", min: "0,0" },
    });
    const local = await motis.stops({
      client: motisLocalInstance.client,
      query: { max: "0.1,0.1", min: "0,0" },
    });

    expect(cloud.data).toEqual([]);
    expect(local.data).toEqual([]);

    const cloudRequest = getRequest(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
    const localRequest = getRequest(fetchMock.mock.calls[1]?.[0], fetchMock.mock.calls[1]?.[1]);

    expect(cloudRequest.url).toBe("https://cloud.example/api/v6/map/stops?max=0.1%2C0.1&min=0%2C0");
    expect(cloudRequest.headers.get("User-Agent")).toBe("OpenMapX-Test/1.0");
    expect(cloudRequest.signal).toBeInstanceOf(AbortSignal);

    expect(localRequest.url).toBe("http://local.example/api/v6/map/stops?max=0.1%2C0.1&min=0%2C0");
    expect(localRequest.signal).toBeInstanceOf(AbortSignal);
  });

  it("works with geocoding-motis and falls back from local to Transitous on local API errors", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      const url = new URL(request.url);

      if (request.method === "HEAD" && url.pathname === "/api/v1/plan") {
        expect(url.origin).toBe("http://local.example");
        return emptyResponse(200);
      }

      if (url.origin === "http://local.example" && url.pathname === "/api/v1/geocode") {
        expect(url.searchParams.get("text")).toBe("Berlin");
        expect(url.searchParams.get("language")).toBe("de");
        return jsonResponse({ message: "local unavailable" }, { status: 503 });
      }

      if (url.origin === "https://cloud.example" && url.pathname === "/api/v1/geocode") {
        expect(url.searchParams.get("text")).toBe("Berlin");
        expect(url.searchParams.get("language")).toBe("de");
        return jsonResponse([
          {
            areas: [{ default: true, name: "Berlin" }],
            category: "station",
            houseNumber: "1",
            id: "stop:1",
            lat: 52.52,
            lon: 13.405,
            modes: ["RAIL"],
            name: "Berlin Hbf",
            score: 87,
            street: "Europaplatz",
            type: "STOP",
          },
        ]);
      }

      if (url.origin === "http://local.example" && url.pathname === "/api/v1/reverse-geocode") {
        expect(url.searchParams.get("place")).toBe("52.52,13.405");
        return jsonResponse([
          {
            areas: [{ default: true, name: "Berlin" }],
            category: "station",
            houseNumber: "1",
            id: "stop:1",
            lat: 52.52,
            lon: 13.405,
            modes: ["RAIL"],
            name: "Berlin Hbf",
            score: 87,
            street: "Europaplatz",
            type: "STOP",
          },
        ]);
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { motisGeocodingService, setMotisLocalUrl, setTransitousUrl } = await import(
      "@integrations/geocoding-motis/provider.js"
    );

    setMotisLocalUrl("http://local.example");
    setTransitousUrl("https://cloud.example");

    const geocoded = await motisGeocodingService.geocode("Berlin", "de");
    const reversed = await motisGeocodingService.reverseGeocode(52.52, 13.405);

    expect(geocoded).toEqual([
      {
        confidence: 0.87,
        coordinates: [13.405, 52.52],
        id: "stop:1",
        label: "Berlin Hbf",
        rawCategory: "station",
        type: "poi",
      },
    ]);
    expect(reversed).toEqual({
      address: "Europaplatz 1",
      city: "Berlin",
    });
  });

  it("works with shared mobility rentals and falls back from local to Transitous on local API errors", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const request = getRequest(input, init);
      const url = new URL(request.url);

      if (request.method === "HEAD" && url.pathname === "/api/v1/plan") {
        expect(url.origin).toBe("http://local.example");
        return emptyResponse(200);
      }

      if (url.origin === "http://local.example" && url.pathname === "/api/v1/rentals") {
        expect(url.searchParams.get("min")).toBe("52.4,13.3");
        expect(url.searchParams.get("max")).toBe("52.6,13.5");
        return jsonResponse({ message: "local unavailable" }, { status: 500 });
      }

      if (url.origin === "https://cloud.example" && url.pathname === "/api/v1/rentals") {
        expect(url.searchParams.get("withProviders")).toBe("true");
        expect(url.searchParams.get("withStations")).toBe("true");
        expect(url.searchParams.get("withVehicles")).toBe("true");
        expect(url.searchParams.get("withZones")).toBe("true");
        return jsonResponse({
          providerGroups: [
            {
              id: "bike-group",
              name: "Bike group",
              color: "#00aa00",
              providers: ["nextbike"],
              formFactors: ["BICYCLE"],
            },
          ],
          providers: [
            {
              id: "nextbike",
              name: "Nextbike",
              groupId: "bike-group",
              bbox: [13.3, 52.4, 13.5, 52.6],
              formFactors: ["BICYCLE"],
              vehicleTypes: [
                {
                  id: "BICYCLE",
                  name: "Bike",
                  formFactor: "BICYCLE",
                  propulsionType: "HUMAN",
                  returnConstraint: "ANY_STATION",
                  returnConstraintGuessed: false,
                },
              ],
              defaultRestrictions: {
                vehicleTypeIdxs: [],
                rideStartAllowed: true,
                rideEndAllowed: true,
                rideThroughAllowed: true,
              },
              globalGeofencingRules: [],
            },
          ],
          stations: [
            {
              formFactors: ["BICYCLE"],
              id: "station-1",
              isRenting: true,
              isReturning: true,
              lat: 52.5,
              lon: 13.4,
              name: "Station 1",
              providerId: "nextbike",
              providerGroupId: "bike-group",
              rentalUriWeb: "https://nextbike.example",
              vehicleDocksAvailable: { BICYCLE: 3 },
              vehicleTypesAvailable: { BICYCLE: 5 },
            },
          ],
          vehicles: [
            {
              formFactor: "BICYCLE",
              id: "vehicle-1",
              isDisabled: false,
              isReserved: false,
              lat: 52.5001,
              lon: 13.4001,
              propulsionType: "HUMAN",
              providerId: "nextbike",
              providerGroupId: "bike-group",
              typeId: "BICYCLE",
              returnConstraint: "ANY_STATION",
            },
          ],
          zones: [],
        });
      }

      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { createMotisRentalsClient } = await import(
      "../../../../../packages/mobility-core/src/motis-rentals.js"
    );
    const client = createMotisRentalsClient({
      motisUrl: "http://local.example",
      transitousUrl: "https://cloud.example",
      rentalSourceIndex: [{ sourceId: "gbfs/nextbike", registrySystemId: "nextbike" }],
    });

    const rentals = await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6], ["bicycle"]);

    expect(rentals).toMatchObject({
      origin: "transitous",
      completeness: { providers: true, stations: true, vehicles: true, zones: true },
      providers: [{ nativeId: "nextbike", sourceId: "gbfs/nextbike" }],
      providerGroups: [{ nativeId: "bike-group" }],
      stations: [
        {
          nativeId: "station-1",
          availableVehicles: 5,
          emptySlots: 3,
          capacity: 8,
          isRenting: true,
          isReturning: true,
          sources: ["gbfs/nextbike"],
        },
      ],
      vehicles: [
        {
          nativeId: "vehicle-1",
          formFactor: "bicycle",
          propulsion: "human",
          returnConstraint: "any_station",
          sources: ["gbfs/nextbike"],
        },
      ],
      zones: [],
    });
  });
});
