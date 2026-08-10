import { describe, expect, it } from "vitest";
import {
  buildTransitNavigationPackage,
  stripTransitSecretsForSnapshot,
  transitItineraryFingerprint,
} from "./transitPackage";

const CAPTURED_AT = 1_700_000_100_000;
const TOKEN = "tok_rotating_secret_value";

function place(stopId: string, name: string) {
  return { stopId, name, lat: 50.11, lng: 8.68 };
}

function itinerary(overrides: Record<string, unknown> = {}) {
  return {
    startTime: "2026-08-09T08:00:00Z",
    endTime: "2026-08-09T08:45:00Z",
    durationSeconds: 2_700,
    refreshToken: TOKEN,
    legs: [
      {
        mode: "walking",
        from: place("origin", "Home"),
        to: place("stop-a", "Hauptbahnhof"),
        startTime: "2026-08-09T08:00:00Z",
        endTime: "2026-08-09T08:08:00Z",
        durationSeconds: 480,
      },
      {
        mode: "rail",
        route: { id: "route-1", shortName: "S1" },
        tripId: "trip-1",
        from: place("stop-a", "Hauptbahnhof"),
        to: place("stop-d", "Messe"),
        startTime: "2026-08-09T08:10:00Z",
        endTime: "2026-08-09T08:40:00Z",
        scheduledStartTime: "2026-08-09T08:10:00Z",
        scheduledEndTime: "2026-08-09T08:40:00Z",
        durationSeconds: 1_800,
      },
      {
        mode: "walking",
        from: place("stop-d", "Messe"),
        to: place("destination", "Office"),
        startTime: "2026-08-09T08:40:00Z",
        endTime: "2026-08-09T08:45:00Z",
        durationSeconds: 300,
      },
    ],
    ...overrides,
  } as never;
}

const JOURNEYS = {
  "trip-1": [
    { stopId: "stop-a", name: "Hauptbahnhof", lat: 50.11, lng: 8.68 },
    { stopId: "stop-b", name: "Galluswarte", lat: 50.11, lng: 8.66 },
    { stopId: "stop-c", name: "Messe West", lat: 50.11, lng: 8.65 },
    { stopId: "stop-d", name: "Messe", lat: 50.11, lng: 8.64 },
  ],
};

const SETTINGS = { voiceEnabled: true, keepScreenOn: true, alightAlertsEnabled: true };

function build(overrides: Record<string, unknown> = {}) {
  return buildTransitNavigationPackage({
    itinerary: itinerary(),
    journeys: JOURNEYS,
    locale: "en",
    units: "metric",
    settings: SETTINGS,
    capturedAtMs: CAPTURED_AT,
    ...overrides,
  } as never);
}

describe("buildTransitNavigationPackage", () => {
  it("captures the board-to-alight slice of each ride", () => {
    const result = build();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const capture = result.startPackage.captures.find((entry) => entry.tripId === "trip-1");
    expect(capture?.status).toBe("captured");
    expect(capture?.stops.map((stop) => stop.stopId)).toEqual([
      "stop-a",
      "stop-b",
      "stop-c",
      "stop-d",
    ]);
  });

  it("records a missing capture rather than inventing stops", () => {
    // A journey the server could not supply must be distinguishable from a ride
    // that genuinely makes no intermediate stops.
    const result = build({ journeys: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const capture = result.startPackage.captures[0];
    expect(capture.status).toBe("missing");
    expect(capture.stops).toEqual([]);
  });

  it("captures nothing for a walking leg", () => {
    const result = build();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.captures).toHaveLength(1);
  });

  it("keeps the itinerary the rider is following", () => {
    const result = build();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.startPackage.itinerary as { legs: unknown[] }).legs).toHaveLength(3);
  });

  it("carries the locale, units and settings it was given", () => {
    const result = build({ locale: "de", units: "imperial" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.startPackage.locale).toBe("de");
    expect(result.startPackage.units).toBe("imperial");
    expect(result.startPackage.settings).toEqual(SETTINGS);
  });

  it("carries replan options only when they exist", () => {
    expect(
      build().ok &&
        (build() as { startPackage: { replanOptions?: unknown } }).startPackage.replanOptions,
    ).toBeUndefined();

    const withOptions = build({ replanOptions: { wheelchair: true, maxTransfers: 2 } });
    expect(withOptions.ok).toBe(true);
    if (!withOptions.ok) return;
    expect(withOptions.startPackage.replanOptions).toEqual({ wheelchair: true, maxTransfers: 2 });
  });

  it("refuses an itinerary with nowhere to go", () => {
    expect(build({ itinerary: itinerary({ legs: [] }) })).toEqual({
      ok: false,
      code: "no-destination",
    });
  });

  it.each([
    ["an unsupported locale", { locale: "fr" }],
    ["an unsupported unit", { units: "furlongs" }],
    ["incomplete settings", { settings: { voiceEnabled: true } }],
  ])("refuses %s", (_label, overrides) => {
    expect(build(overrides)).toEqual({ ok: false, code: "invalid-package" });
  });
});

describe("transitItineraryFingerprint", () => {
  it("is stable for the same structural trip", () => {
    expect(transitItineraryFingerprint(itinerary())).toBe(transitItineraryFingerprint(itinerary()));
  });

  it("does not change when a live time moves", () => {
    // This is the whole point: a refresh that reports a delay must not read as a
    // different journey, or progress would be discarded every thirty seconds.
    const delayed = itinerary() as unknown as { legs: Array<Record<string, unknown>> };
    delayed.legs[1].startTime = "2026-08-09T08:14:00Z";
    delayed.legs[1].endTime = "2026-08-09T08:44:00Z";

    expect(transitItineraryFingerprint(delayed as never)).toBe(
      transitItineraryFingerprint(itinerary()),
    );
  });

  it("does not change when the refresh token rotates", () => {
    expect(transitItineraryFingerprint(itinerary({ refreshToken: "tok_new" }))).toBe(
      transitItineraryFingerprint(itinerary()),
    );
  });

  it("changes when the trip itself changes", () => {
    const other = itinerary() as unknown as { legs: Array<Record<string, unknown>> };
    other.legs[1].tripId = "trip-2";

    expect(transitItineraryFingerprint(other as never)).not.toBe(
      transitItineraryFingerprint(itinerary()),
    );
  });

  it("changes when a scheduled time changes", () => {
    const other = itinerary() as unknown as { legs: Array<Record<string, unknown>> };
    other.legs[1].scheduledStartTime = "2026-08-09T09:10:00Z";

    expect(transitItineraryFingerprint(other as never)).not.toBe(
      transitItineraryFingerprint(itinerary()),
    );
  });

  it("changes when a leg is added or removed", () => {
    const other = itinerary() as unknown as { legs: unknown[] };
    other.legs.pop();

    expect(transitItineraryFingerprint(other as never)).not.toBe(
      transitItineraryFingerprint(itinerary()),
    );
  });
});

describe("stripTransitSecretsForSnapshot", () => {
  it("removes the rotating token from an itinerary", () => {
    const stripped = stripTransitSecretsForSnapshot(itinerary());

    expect(JSON.stringify(stripped)).not.toContain(TOKEN);
    expect((stripped as { refreshToken?: string }).refreshToken).toBeUndefined();
  });

  it("removes a token the server nested anywhere", () => {
    // Key-based rather than shape-based, so moving the field server-side does
    // not silently start leaking it.
    const nested = { a: { b: [{ c: { refreshToken: TOKEN } }] } };

    expect(JSON.stringify(stripTransitSecretsForSnapshot(nested))).not.toContain(TOKEN);
  });

  it("keeps everything the page actually needs", () => {
    const stripped = stripTransitSecretsForSnapshot(itinerary()) as { legs: unknown[] };

    expect(stripped.legs).toHaveLength(3);
    expect(JSON.stringify(stripped)).toContain("Hauptbahnhof");
  });

  it("leaves a value that is not an object alone", () => {
    expect(stripTransitSecretsForSnapshot("plain")).toBe("plain");
    expect(stripTransitSecretsForSnapshot(42)).toBe(42);
    expect(stripTransitSecretsForSnapshot(null)).toBeNull();
  });

  it("survives a deeply nested structure without recursing forever", () => {
    let deep: Record<string, unknown> = { refreshToken: TOKEN };
    for (let index = 0; index < 100; index += 1) deep = { nested: deep };

    expect(() => stripTransitSecretsForSnapshot(deep)).not.toThrow();
  });

  it("removes the token from a built package before it is published", () => {
    const result = build();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The package itself keeps it — native is its exclusive consumer.
    expect(JSON.stringify(result.startPackage)).toContain(TOKEN);
    expect(JSON.stringify(stripTransitSecretsForSnapshot(result.startPackage))).not.toContain(
      TOKEN,
    );
  });
});
