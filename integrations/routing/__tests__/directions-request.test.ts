import type { RouteQuery } from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  createDirectionsCacheIdentity,
  DIRECTIONS_REQUEST_POLICY,
  type DirectionsRequestPolicy,
  OPTIMIZE_DIRECTIONS_REQUEST_POLICY,
  parseDirectionsRequest,
} from "../directions-request";

const THREE_WAYPOINTS = "6.0839,50.7753;6.0912,50.7701;6.1015,50.7644";

const POLICIES: readonly [string, DirectionsRequestPolicy][] = [
  ["directions", DIRECTIONS_REQUEST_POLICY],
  ["optimization", OPTIMIZE_DIRECTIONS_REQUEST_POLICY],
];

describe.each(POLICIES)("%s request parsing", (_label, policy) => {
  it("normalizes the common routing request fields", () => {
    const request = parseDirectionsRequest(
      {
        waypoints: THREE_WAYPOINTS,
        mode: "Motorcycle",
        avoidHighways: "true",
        avoidTolls: "false",
        avoidFerries: "true",
        avoidClosures: "1",
        units: "imperial",
        lang: "de",
        departAt: "2026-09-02T08:30:45+02:00",
      },
      policy,
    );

    expect(request).toEqual({
      operation: policy.operation,
      waypoints: [
        [6.0839, 50.7753],
        [6.0912, 50.7701],
        [6.1015, 50.7644],
      ],
      travelMode: "motorcycle",
      avoidClosures: true,
      requireTimeAware: true,
      routingOptions: {
        avoidHighways: true,
        avoidTolls: false,
        avoidFerries: true,
        units: "imperial",
        lang: "de",
        departAt: "2026-09-02T08:30",
        arriveBy: undefined,
        useLiveTraffic: true,
      },
    });
  });

  it("applies the operation minimum to the endpoint shorthand", () => {
    const query = {
      originLng: "6.0839",
      originLat: "50.7753",
      destLng: "6.1015",
      destLat: "50.7644",
      avoidClosures: "true",
    };

    if (policy.operation === "optimize") {
      expect(() => parseDirectionsRequest(query, policy)).toThrow(policy.minimumWaypointsError);
      return;
    }

    const request = parseDirectionsRequest(query, policy);

    expect(request.waypoints).toEqual([
      [6.0839, 50.7753],
      [6.1015, 50.7644],
    ]);
    expect(request.travelMode).toBe("driving");
    expect(request.avoidClosures).toBe(true);
    expect(request.requireTimeAware).toBe(false);
    expect(request.routingOptions).toEqual({
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      units: "metric",
      lang: undefined,
      departAt: undefined,
      arriveBy: undefined,
      useLiveTraffic: true,
    });
  });

  it.each([
    [{}, "Provide either 'waypoints'"],
    [{ waypoints: "6.08,50.77;invalid" }, "Waypoints must contain 2-50 valid WGS84"],
    [
      { originLng: "181", originLat: "50", destLng: "6", destLat: "51" },
      "Origin and destination must be valid WGS84 coordinates",
    ],
    [{ waypoints: THREE_WAYPOINTS, mode: "flying" }, 'Invalid mode: "flying"'],
    [{ waypoints: THREE_WAYPOINTS, departAt: "not-a-date" }, "Invalid departAt"],
    [
      {
        waypoints: THREE_WAYPOINTS,
        departAt: "2026-09-02T08:30",
        arriveBy: "2026-09-02T10:00",
      },
      "departAt and arriveBy are mutually exclusive",
    ],
  ] satisfies readonly [RouteQuery, string][])(
    "rejects %# with the public error",
    (query, error) => {
      expect(() => parseDirectionsRequest(query, policy)).toThrow(error);
    },
  );

  it("uses the operation-specific transit error", () => {
    expect(() =>
      parseDirectionsRequest({ waypoints: THREE_WAYPOINTS, mode: "transit" }, policy),
    ).toThrow(policy.transitModeError);
  });
});

describe("operation policy", () => {
  it("enforces each operation's waypoint minimum and error", () => {
    const twoWaypoints = { waypoints: "6.0839,50.7753;6.1015,50.7644" };

    expect(parseDirectionsRequest(twoWaypoints, DIRECTIONS_REQUEST_POLICY).waypoints).toHaveLength(
      2,
    );
    expect(() => parseDirectionsRequest(twoWaypoints, OPTIMIZE_DIRECTIONS_REQUEST_POLICY)).toThrow(
      "At least 3 waypoints are required for optimization",
    );
  });
});

describe("directions cache identity", () => {
  it.each(POLICIES)("derives the %s key fields from the parsed request", (_label, policy) => {
    const request = parseDirectionsRequest(
      {
        waypoints: "6.08394,50.77534;6.09126,50.77016;6.10156,50.76446",
        avoidTolls: "true",
      },
      policy,
    );

    expect(createDirectionsCacheIdentity(request, "excl:abc")).toEqual({
      arriveBy: null,
      avoidClosures: false,
      avoidFerries: false,
      avoidHighways: false,
      avoidTolls: true,
      departAt: null,
      exclusionsHash: "excl:abc",
      lang: "en",
      mode: "driving",
      ...(policy.operation === "optimize" ? { optimize: true } : {}),
      units: "metric",
      waypoints: [
        [6.0839, 50.7753],
        [6.0913, 50.7702],
        [6.1016, 50.7645],
      ],
    });
  });

  it.each(POLICIES)("distinguishes %s closure policy and geometry states", (_label, policy) => {
    const closureOff = parseDirectionsRequest({ waypoints: THREE_WAYPOINTS }, policy);
    const closureOn = parseDirectionsRequest(
      { waypoints: THREE_WAYPOINTS, avoidClosures: "true" },
      policy,
    );
    const identities = [
      createDirectionsCacheIdentity(closureOff, null),
      createDirectionsCacheIdentity(closureOn, null),
      createDirectionsCacheIdentity(closureOn, "excl:abc"),
    ];

    expect(new Set(identities.map((identity) => JSON.stringify(identity))).size).toBe(3);
  });
});
