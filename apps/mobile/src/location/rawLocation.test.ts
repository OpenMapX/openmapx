import { sanitiseBatch } from "../background/handleFeasibilityBatch";
import {
  MAX_FIX_AGE_MS,
  MAX_FIX_SKEW_MS,
  type RawLocation,
  sanitiseRawLocations,
} from "./rawLocation";
import { sanitiseFixes } from "./sanitiseFixes";

const NOW = 1_700_000_000_000;

interface AcceptedFix {
  coords: [number, number];
  accuracy: number;
  timestampMs: number;
  speed?: number | null;
  heading?: number | null;
  speedMps?: number;
  headingDegrees?: number;
}

type Sanitiser = (
  locations: readonly RawLocation[],
  nowMs: number,
  watermark: number | null,
) => { accepted: AcceptedFix[]; rejectedCount: number };

const ADAPTERS: readonly [string, Sanitiser][] = [
  ["canonical", sanitiseRawLocations],
  ["feasibility", sanitiseBatch],
  ["navigation", sanitiseFixes],
];

function raw(timestamp = NOW - 1_000, coords: Partial<RawLocation["coords"]> = {}): RawLocation {
  return {
    timestamp,
    coords: {
      latitude: 50.11,
      longitude: 8.68,
      accuracy: 5,
      ...coords,
    },
  };
}

function invalidate(
  mutate: (location: RawLocation) => unknown,
): (location: RawLocation) => RawLocation {
  return (location) => mutate(location) as RawLocation;
}

describe.each(ADAPTERS)("%s raw-location adapter", (_name, sanitise) => {
  it.each([
    ["zero timestamp", invalidate((location) => ({ ...location, timestamp: 0 }))],
    ["NaN timestamp", invalidate((location) => ({ ...location, timestamp: Number.NaN }))],
    [
      "infinite timestamp",
      invalidate((location) => ({ ...location, timestamp: Number.POSITIVE_INFINITY })),
    ],
    [
      "stale timestamp",
      invalidate((location) => ({ ...location, timestamp: NOW - MAX_FIX_AGE_MS - 1 })),
    ],
    [
      "future timestamp",
      invalidate((location) => ({ ...location, timestamp: NOW + MAX_FIX_SKEW_MS + 1 })),
    ],
    ["null location", invalidate(() => null)],
    ["missing coordinates", invalidate((location) => ({ ...location, coords: undefined }))],
    ["latitude below range", (location: RawLocation) => raw(location.timestamp, { latitude: -91 })],
    ["latitude above range", (location: RawLocation) => raw(location.timestamp, { latitude: 91 })],
    ["NaN latitude", (location: RawLocation) => raw(location.timestamp, { latitude: Number.NaN })],
    [
      "longitude below range",
      (location: RawLocation) => raw(location.timestamp, { longitude: -181 }),
    ],
    [
      "longitude above range",
      (location: RawLocation) => raw(location.timestamp, { longitude: 181 }),
    ],
    [
      "infinite longitude",
      (location: RawLocation) => raw(location.timestamp, { longitude: Number.POSITIVE_INFINITY }),
    ],
    [
      "missing accuracy",
      (location: RawLocation) => raw(location.timestamp, { accuracy: undefined }),
    ],
    ["null accuracy", (location: RawLocation) => raw(location.timestamp, { accuracy: null })],
    ["negative accuracy", (location: RawLocation) => raw(location.timestamp, { accuracy: -1 })],
    ["NaN accuracy", (location: RawLocation) => raw(location.timestamp, { accuracy: Number.NaN })],
    [
      "infinite accuracy",
      (location: RawLocation) => raw(location.timestamp, { accuracy: Number.POSITIVE_INFINITY }),
    ],
  ])("rejects %s", (_case, makeInvalid) => {
    const result = sanitise([makeInvalid(raw())], NOW, null);

    expect(result).toEqual({ accepted: [], rejectedCount: 1 });
  });

  it("accepts coordinate, age, and clock-skew boundaries", () => {
    const result = sanitise(
      [
        raw(NOW - MAX_FIX_AGE_MS, { latitude: -90, longitude: -180, accuracy: 0 }),
        raw(NOW + MAX_FIX_SKEW_MS, { latitude: 90, longitude: 180 }),
      ],
      NOW,
      null,
    );

    expect(result.accepted.map((fix) => fix.timestampMs)).toEqual([
      NOW - MAX_FIX_AGE_MS,
      NOW + MAX_FIX_SKEW_MS,
    ]);
    expect(result.rejectedCount).toBe(0);
  });

  it("sorts out-of-order batches and filters duplicate and prior timestamps", () => {
    const result = sanitise(
      [raw(NOW - 1_000), raw(NOW - 3_000), raw(NOW - 2_000), raw(NOW - 2_000)],
      NOW,
      NOW - 2_500,
    );

    expect(result.accepted.map((fix) => fix.timestampMs)).toEqual([NOW - 2_000, NOW - 1_000]);
    expect(result.rejectedCount).toBe(0);
  });

  it("drops invalid optional motion values without rejecting the position", () => {
    const [fix] = sanitise([raw(NOW - 1_000, { speed: -1, heading: -1 })], NOW, null).accepted;

    expect(fix).toBeDefined();
    expect(fix).not.toHaveProperty("speed");
    expect(fix).not.toHaveProperty("speedMps");
    expect(fix).not.toHaveProperty("heading");
    expect(fix).not.toHaveProperty("headingDegrees");
  });

  it("drops non-finite optional motion values", () => {
    const [fix] = sanitise(
      [raw(NOW - 1_000, { speed: Number.POSITIVE_INFINITY, heading: Number.NaN })],
      NOW,
      null,
    ).accepted;

    expect(fix).toBeDefined();
    expect(fix).not.toHaveProperty("speed");
    expect(fix).not.toHaveProperty("speedMps");
    expect(fix).not.toHaveProperty("heading");
    expect(fix).not.toHaveProperty("headingDegrees");
  });

  it("keeps zero speed but drops a heading above its range", () => {
    const [fix] = sanitise([raw(NOW - 1_000, { speed: 0, heading: 361 })], NOW, null).accepted;

    expect(fix.speed ?? fix.speedMps).toBe(0);
    expect(fix).not.toHaveProperty("heading");
    expect(fix).not.toHaveProperty("headingDegrees");
  });
});

describe("raw-location output adapters", () => {
  it("maps canonical motion fields to each public fix contract", () => {
    const location = raw(NOW - 1_000, { speed: 4.5, heading: 270 });

    expect(sanitiseRawLocations([location], NOW, null).accepted[0]).toMatchObject({
      speedMps: 4.5,
      headingDegrees: 270,
    });
    expect(sanitiseBatch([location], NOW, null).accepted[0]).toMatchObject({
      speedMps: 4.5,
      headingDegrees: 270,
    });
    expect(sanitiseFixes([location], NOW, null).accepted[0]).toMatchObject({
      speed: 4.5,
      heading: 270,
    });
  });
});
