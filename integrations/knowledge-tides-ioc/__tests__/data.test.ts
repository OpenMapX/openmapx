import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveExtrema, fetchObservations, reformatIocTime } from "../index.js";

// The IOC Sea Level Monitoring API returns raw gauge observations (metres) with
// UTC timestamps that carry no zone marker. These tests pin the timestamp
// reformatting, the sensor-selection / sort in `fetchObservations`, and the
// metres→feet conversion applied to the derived high/low extrema.

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reformatIocTime", () => {
  it("converts a space-separated UTC stamp to ISO-8601 with a Z marker", () => {
    expect(reformatIocTime("2026-05-17 22:30:00")).toBe("2026-05-17T22:30:00Z");
  });

  it("handles a minute-only stamp", () => {
    expect(reformatIocTime("2026-05-17 22:30")).toBe("2026-05-17T22:30Z");
  });

  it("returns the input unchanged when it does not match the expected shape", () => {
    expect(reformatIocTime("garbage")).toBe("garbage");
  });
});

describe("fetchObservations", () => {
  it("selects the most-populated sensor, drops non-finite levels, and sorts by time", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        // prs sensor: only one point — should be discarded as less populated.
        { sensor: "prs", stime: "2026-05-17 22:00:00", slevel: 9.9 },
        // rad sensor: three valid points, supplied out of order.
        { sensor: "rad", stime: "2026-05-17 22:30:00", slevel: 1.2 },
        { sensor: "rad", stime: "2026-05-17 22:00:00", slevel: 1.0 },
        { sensor: "rad", stime: "2026-05-17 22:45:00", slevel: 1.3 },
        // a non-finite reading on the winning sensor must be filtered out.
        { sensor: "rad", stime: "2026-05-17 22:15:00", slevel: Number.NaN },
      ]),
    );

    const obs = await fetchObservations("acld");

    expect(obs.map((p) => p.sensor)).toEqual(["rad", "rad", "rad"]);
    expect(obs.map((p) => p.stime)).toEqual([
      "2026-05-17 22:00:00",
      "2026-05-17 22:30:00",
      "2026-05-17 22:45:00",
    ]);
    expect(obs.map((p) => p.slevel)).toEqual([1.0, 1.2, 1.3]);
  });

  it("returns an empty array when the upstream call fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    expect(await fetchObservations("acld")).toEqual([]);
  });
});

describe("deriveExtrema", () => {
  it("derives a high from a rise-then-fall curve and converts metres to feet", () => {
    const curve = [
      { time: "2026-05-17T18:00:00Z", value: 0.0 },
      { time: "2026-05-17T18:30:00Z", value: 0.3 },
      { time: "2026-05-17T19:00:00Z", value: 0.6 },
      { time: "2026-05-17T19:30:00Z", value: 0.9 },
      { time: "2026-05-17T20:00:00Z", value: 1.0 },
      { time: "2026-05-17T20:30:00Z", value: 0.7 },
      { time: "2026-05-17T21:00:00Z", value: 0.4 },
      { time: "2026-05-17T21:30:00Z", value: 0.1 },
    ];

    const events = deriveExtrema(curve);

    expect(events).toEqual([{ time: "2026-05-17T20:00:00Z", type: "H", valueFt: 3.28 }]);
  });

  it("returns no events for a flat (noise-only) series", () => {
    const flat = Array.from({ length: 8 }, (_, i) => ({
      time: `2026-05-17T${String(18 + i).padStart(2, "0")}:00:00Z`,
      value: 0.5,
    }));
    expect(deriveExtrema(flat)).toEqual([]);
  });
});
