import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateShareToken,
  hashShareToken,
  isExpired,
  listSnapshotFrom,
  parseStoredListSnapshot,
  routeShareLabel,
  SHARE_TOKEN_PATTERN,
  toOwnerShare,
  toPublicListShare,
  toPublicRouteShare,
  validateRouteShare,
} from "../share-links";

const ROUTE = {
  waypoints: [
    { lat: 52.52, lng: 13.405, label: "Berlin" },
    { lat: 53.55, lng: 9.99, label: "Hamburg" },
  ],
  mode: "driving" as const,
  avoidTolls: true,
};

describe("share tokens", () => {
  it("generates 43-char base64url tokens that match the route pattern", () => {
    const token = generateShareToken();
    expect(token).toHaveLength(43);
    expect(new RegExp(SHARE_TOKEN_PATTERN).test(token)).toBe(true);
  });

  it("generates distinct tokens", () => {
    expect(generateShareToken()).not.toEqual(generateShareToken());
  });

  it("hashes with sha256/base64url and never returns the input", () => {
    const token = generateShareToken();
    const expected = createHash("sha256").update(token, "utf8").digest("base64url");
    expect(hashShareToken(token)).toEqual(expected);
    expect(hashShareToken(token)).not.toEqual(token);
  });
});

describe("isExpired", () => {
  const now = new Date("2026-08-31T12:00:00Z");
  it("null expiry never expires", () => {
    expect(isExpired({ expiresAt: null }, now)).toBe(false);
  });
  it("future expiry is not expired, past is", () => {
    expect(isExpired({ expiresAt: new Date("2026-09-01T00:00:00Z") }, now)).toBe(false);
    expect(isExpired({ expiresAt: new Date("2026-08-31T11:59:59Z") }, now)).toBe(true);
  });
});

describe("validateRouteShare", () => {
  it("accepts a well-formed payload and strips unknown fields", () => {
    const parsed = validateRouteShare({ ...ROUTE, extra: "nope" });
    expect(parsed).toEqual(ROUTE);
    expect(parsed && "extra" in parsed).toBe(false);
  });
  it.each([
    ["too few waypoints", { ...ROUTE, waypoints: [ROUTE.waypoints[0]] }],
    ["too many waypoints", { ...ROUTE, waypoints: Array(11).fill(ROUTE.waypoints[0]) }],
    [
      "out-of-range lat",
      {
        ...ROUTE,
        waypoints: [
          { lat: 91, lng: 0 },
          { lat: 0, lng: 0 },
        ],
      },
    ],
    [
      "out-of-range lng",
      {
        ...ROUTE,
        waypoints: [
          { lat: 0, lng: 181 },
          { lat: 0, lng: 0 },
        ],
      },
    ],
    ["bad mode", { ...ROUTE, mode: "transit" }],
    [
      "oversized label",
      {
        ...ROUTE,
        waypoints: [
          { lat: 0, lng: 0, label: "x".repeat(201) },
          { lat: 1, lng: 1 },
        ],
      },
    ],
    ["not an object", "route"],
  ])("rejects %s", (_name, input) => {
    expect(validateRouteShare(input)).toBeNull();
  });
});

describe("routeShareLabel", () => {
  it("uses first and last waypoint labels", () => {
    expect(routeShareLabel(ROUTE)).toBe("Berlin → Hamburg");
  });
  it("falls back to rounded coordinates when labels are missing", () => {
    const label = routeShareLabel({
      waypoints: [
        { lat: 52.520008, lng: 13.404954 },
        { lat: 53.550341, lng: 9.992196 },
      ],
      mode: "walking",
    });
    expect(label).toBe("52.5200, 13.4050 → 53.5503, 9.9922");
  });
});

describe("list snapshot + public projections", () => {
  const dbPlace = {
    id: "place-1",
    listId: "list-1",
    name: "Cafe",
    address: "Street 1",
    lat: 52.5,
    lng: 13.4,
    placeId: "osm:node/123",
    note: "good",
    sortOrder: 0,
    createdAt: new Date(),
  };

  it("snapshot keeps only public place fields — no ids", () => {
    const snap = listSnapshotFrom({ name: "$favorites", icon: "heart" }, [dbPlace]);
    expect(snap.places[0]).toEqual({
      name: "Cafe",
      address: "Street 1",
      lat: 52.5,
      lng: 13.4,
      note: "good",
      placeId: "osm:node/123",
    });
    expect(JSON.stringify(snap)).not.toMatch(/place-1|list-1|sortOrder|createdAt/);
  });

  it("round-trips through parseStoredListSnapshot", () => {
    const snap = listSnapshotFrom({ name: "Trip", icon: null }, [dbPlace]);
    expect(parseStoredListSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });

  it("parseStoredListSnapshot rejects malformed values", () => {
    expect(parseStoredListSnapshot(null)).toBeNull();
    expect(parseStoredListSnapshot({ name: 1, icon: null, places: [] })).toBeNull();
    expect(parseStoredListSnapshot({ name: "x", icon: null, places: [{ lat: 1 }] })).toBeNull();
  });

  it("toPublicListShare / toPublicRouteShare carry the discriminant", () => {
    const snap = listSnapshotFrom({ name: "Trip", icon: null }, []);
    expect(toPublicListShare("live", snap)).toEqual({
      type: "list",
      mode: "live",
      name: "Trip",
      icon: null,
      places: [],
    });
    expect(toPublicRouteShare(ROUTE)).toEqual({ type: "route", mode: "snapshot", route: ROUTE });
  });
});

describe("toOwnerShare", () => {
  it("copies fields explicitly with ISO timestamps and no tokenHash/snapshot", () => {
    const row = {
      id: "share-1",
      userId: "user-1",
      tokenHash: "HASH",
      targetType: "list",
      targetId: "list-1",
      mode: "live",
      label: "Trip",
      snapshot: null,
      createdAt: new Date("2026-08-30T10:00:00Z"),
      updatedAt: new Date("2026-08-30T10:00:00Z"),
      expiresAt: null,
    };
    const owner = toOwnerShare(row);
    expect(owner).toEqual({
      id: "share-1",
      targetType: "list",
      targetId: "list-1",
      mode: "live",
      label: "Trip",
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
      expiresAt: null,
    });
    expect(JSON.stringify(owner)).not.toMatch(/HASH|user-1|snapshot/);
  });
});

describe("validateRouteShare with per-waypoint schedules", () => {
  it("accepts an aligned schedules array and records the version", () => {
    const parsed = validateRouteShare({
      ...ROUTE,
      schedules: [
        null,
        { arriveBy: "2026-09-01T14:00", dwellSeconds: 1800, timeZone: "Europe/Berlin" },
      ],
    });
    expect(parsed?.scheduleVersion).toBe(1);
    expect(parsed?.schedules).toEqual([
      null,
      { arriveBy: "2026-09-01T14:00", dwellSeconds: 1800, timeZone: "Europe/Berlin" },
    ]);
  });

  it("omits the schedules entirely when every entry is unconstrained", () => {
    const parsed = validateRouteShare({ ...ROUTE, schedules: [null, null] });
    expect(parsed?.schedules).toBeUndefined();
    expect(parsed?.scheduleVersion).toBeUndefined();
  });

  it("rejects a schedules array that does not align with the waypoints", () => {
    expect(validateRouteShare({ ...ROUTE, schedules: [null] })).toBeNull();
  });

  it("rejects a malformed wall clock", () => {
    expect(
      validateRouteShare({ ...ROUTE, schedules: [null, { arriveBy: "tomorrow" }] }),
    ).toBeNull();
  });

  it("rejects an unrecognized time zone", () => {
    expect(
      validateRouteShare({ ...ROUTE, schedules: [null, { timeZone: "Not/AZone" }] }),
    ).toBeNull();
  });

  it("rejects an out-of-range or fractional dwell", () => {
    expect(
      validateRouteShare({ ...ROUTE, schedules: [null, { dwellSeconds: 100_000 }] }),
    ).toBeNull();
    expect(validateRouteShare({ ...ROUTE, schedules: [null, { dwellSeconds: 90.5 }] })).toBeNull();
    expect(validateRouteShare({ ...ROUTE, schedules: [null, { dwellSeconds: -1 }] })).toBeNull();
  });

  it("rejects an unknown schedule field", () => {
    expect(validateRouteShare({ ...ROUTE, schedules: [null, { leaveWhenever: true }] })).toBeNull();
  });

  it("rejects an unknown schedule version", () => {
    expect(
      validateRouteShare({ ...ROUTE, scheduleVersion: 2, schedules: [null, null] }),
    ).toBeNull();
  });

  it("leaves an ordinary payload untouched", () => {
    expect(validateRouteShare(ROUTE)).toEqual(ROUTE);
  });
});
