import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import z from "zod/v4";
import {
  isSupportedMobileProtocol,
  MOBILE_PROTOCOL_MAX,
  MOBILE_PROTOCOL_MIN,
  NATIVE_CLIENT_CONTRACT_DIGESTS,
} from "../../navigation/mobileProtocol";
import type { ApiClient } from "../client";
import { fetchDirections } from "../directions";
import { API_ENDPOINTS } from "../endpoints";
import { fetchGeocode } from "../geocoding";
import { fetchNavigationLandmarks } from "../navigationLandmarks";
import { fetchRouteMatchWindow } from "../routeAttributes";
import { fetchVehicleJourney, refreshTransitItinerary } from "../transit";
import { nativeClientOperations } from "./native-client/index";
import type { ApiOperation, ApiResponseContract } from "./operation";

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  );
}

function jsonSchema(schema: z.ZodType, io: "input" | "output"): unknown {
  return z.toJSONSchema(schema, { io, unrepresentable: "any" });
}

function describeResponse(contract: ApiResponseContract): unknown {
  return "schema" in contract
    ? { kind: contract.kind, schema: jsonSchema(contract.schema, "input") }
    : { kind: contract.kind };
}

function describeOperation(operation: ApiOperation): unknown {
  return {
    method: operation.method,
    path: operation.path,
    auth: operation.auth,
    request: Object.fromEntries(
      Object.entries(operation.request ?? {}).map(([part, schema]) => [
        part,
        jsonSchema(schema, "output"),
      ]),
    ),
    responses: Object.fromEntries(
      Object.entries(operation.responses).map(([status, contract]) => [
        status,
        describeResponse(contract),
      ]),
    ),
  };
}

/** Requests are described as the app produces them, responses as the server sends them. */
function contractDigest(): string {
  const described = Object.fromEntries(
    Object.entries(nativeClientOperations).map(([name, operation]) => [
      name,
      describeOperation(operation),
    ]),
  );
  return createHash("sha256")
    .update(JSON.stringify(sortedKeys(described)))
    .digest("hex");
}

/** Records the one call a fetch function makes, answering with `reply`. */
function recordingClient(reply: unknown) {
  const calls: { method: "GET" | "POST"; path: string; payload: unknown }[] = [];
  const client = {
    get: async (path: string, params?: unknown) => {
      calls.push({ method: "GET", path, payload: params });
      return reply;
    },
    post: async (path: string, body: unknown) => {
      calls.push({ method: "POST", path, payload: body });
      return reply;
    },
  } as unknown as ApiClient;
  return { client, calls };
}

describe("native client contract", () => {
  it("is the contract MOBILE_PROTOCOL_MAX was published with", () => {
    expect(
      contractDigest(),
      "A native client schema changed. Raise MOBILE_PROTOCOL_MIN and MOBILE_PROTOCOL_MAX and append this digest to NATIVE_CLIENT_CONTRACT_DIGESTS.",
    ).toBe(NATIVE_CLIENT_CONTRACT_DIGESTS[MOBILE_PROTOCOL_MAX]);
  });

  it("keeps one distinct digest for every protocol version", () => {
    const versions = Object.keys(NATIVE_CLIENT_CONTRACT_DIGESTS).map(Number);
    expect(versions).toEqual(Array.from({ length: MOBILE_PROTOCOL_MAX }, (_, i) => i + 1));
    const digests = Object.values(NATIVE_CLIENT_CONTRACT_DIGESTS);
    expect(new Set(digests).size).toBe(digests.length);
    expect(MOBILE_PROTOCOL_MIN).toBe(MOBILE_PROTOCOL_MAX);
  });

  it("names the paths the native fetch functions call", () => {
    expect(nativeClientOperations.geocode.path).toBe(API_ENDPOINTS.geocode);
    expect(nativeClientOperations.directions.path).toBe(API_ENDPOINTS.directions);
    expect(nativeClientOperations.matchRoute.path).toBe(API_ENDPOINTS.routingMatch);
    expect(nativeClientOperations.navigationLandmarks.path).toBe(API_ENDPOINTS.navigationLandmarks);
    expect(nativeClientOperations.refreshTransitPlan.path).toBe(API_ENDPOINTS.transitPlanRefresh);
    expect(nativeClientOperations.vehicleJourney.path).toBe(API_ENDPOINTS.transitVehicleJourney);
  });

  it("describes the geocode request the app sends", async () => {
    const { client, calls } = recordingClient([]);
    await fetchGeocode(
      { q: "Alexanderplatz", lang: "de", proximity: [13.4, 52.5], limit: 10 },
      client,
    );
    expect(calls[0]?.path).toBe(nativeClientOperations.geocode.path);
    expect(() =>
      nativeClientOperations.geocode.request.query.parse(calls[0]?.payload),
    ).not.toThrow();
  });

  it.each([
    ["driving", {}],
    ["cycling", { bikeProfile: "road", bikeSpeedKmh: 22.5 }],
  ] as const)("describes the %s directions request the app sends", async (mode, bike) => {
    const { client, calls } = recordingClient({ routes: [] });
    await fetchDirections(
      {
        waypoints: [
          [13.4, 52.5],
          [13.38, 52.51],
        ],
        mode,
        ...bike,
        units: "metric",
        lang: "en",
        avoidHighways: false,
        avoidTolls: true,
        avoidFerries: false,
        avoidClosures: true,
      },
      client,
    );
    expect(calls[0]?.path).toBe(nativeClientOperations.directions.path);
    expect(() =>
      nativeClientOperations.directions.request.query.parse(calls[0]?.payload),
    ).not.toThrow();
  });

  it("describes the match and landmark requests the app sends", async () => {
    const match = recordingClient({ geometry: [], edges: [], points: [] });
    await fetchRouteMatchWindow(
      [
        [13.4, 52.5],
        [13.41, 52.5],
      ],
      "driving",
      { client: match.client },
    );
    expect(match.calls[0]?.path).toBe(nativeClientOperations.matchRoute.path);
    expect(() =>
      nativeClientOperations.matchRoute.request.body.parse(match.calls[0]?.payload),
    ).not.toThrow();

    const landmarks = recordingClient({ results: [{ candidates: [] }] });
    await fetchNavigationLandmarks([{ lat: 52.5, lon: 13.4 }], { client: landmarks.client });
    expect(landmarks.calls[0]?.path).toBe(nativeClientOperations.navigationLandmarks.path);
    expect(() =>
      nativeClientOperations.navigationLandmarks.request.body.parse(landmarks.calls[0]?.payload),
    ).not.toThrow();
  });

  it("describes the transit requests the app sends", async () => {
    const refresh = recordingClient({});
    await refreshTransitItinerary("token-1", refresh.client);
    expect(refresh.calls[0]?.path).toBe(nativeClientOperations.refreshTransitPlan.path);
    expect(() =>
      nativeClientOperations.refreshTransitPlan.request.body.parse(refresh.calls[0]?.payload),
    ).not.toThrow();

    const journey = recordingClient({});
    await fetchVehicleJourney({ tripId: "trip/1" }, journey.client);
    expect(journey.calls[0]).toEqual({
      method: "GET",
      path: nativeClientOperations.vehicleJourney.path.replace(":id", "trip%2F1"),
      payload: undefined,
    });
  });

  it("accepts responses with fields the app does not read", () => {
    expect(
      nativeClientOperations.geocode.responses[200].schema.parse([
        { label: "Alexanderplatz", coordinates: [13.41, 52.52], source: "photon" },
      ]),
    ).toHaveLength(1);
    expect(
      nativeClientOperations.directions.responses[200].schema.safeParse({
        routes: [],
        provider: "valhalla",
      }).success,
    ).toBe(true);
  });

  it("refuses an unsupported protocol with the stable code", () => {
    expect(
      nativeClientOperations.geocode.responses[426].schema.parse({
        error: "Update the app.",
        code: "MOBILE_PROTOCOL_UNSUPPORTED",
      }),
    ).toBeTruthy();
  });
});

describe("isSupportedMobileProtocol", () => {
  it("accepts only decimal versions inside the range", () => {
    expect(isSupportedMobileProtocol(String(MOBILE_PROTOCOL_MAX))).toBe(true);
    for (const value of [
      "0",
      String(MOBILE_PROTOCOL_MAX + 1),
      `0${MOBILE_PROTOCOL_MAX}`,
      `${MOBILE_PROTOCOL_MAX}.0`,
      ` ${MOBILE_PROTOCOL_MAX}`,
      `${MOBILE_PROTOCOL_MAX}, ${MOBILE_PROTOCOL_MAX}`,
      "",
      "x",
    ]) {
      expect(isSupportedMobileProtocol(value)).toBe(false);
    }
  });
});
