import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveExtrema, fetchMeasurements, reformatPegelTime } from "../index.js";

// Pegelonline publishes minute-resolution water levels in centimetres above the
// station gauge zero (PNP), with German-local timestamps carrying a UTC offset
// (e.g. "2026-05-18T06:15:00+02:00"). These tests pin the offset-preserving
// timestamp parse, the 15-sample downsampling in `fetchMeasurements`, and the
// hysteresis high/low detection with the centimetres→feet conversion
// (`CM_TO_FT = 0.0328084`, rounded to 2dp).

function mockOk(data: unknown) {
  return Response.json(data);
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

describe("reformatPegelTime", () => {
  it("preserves the UTC offset so the place panel renders browser-local time", () => {
    expect(reformatPegelTime("2026-05-18T06:15:00+02:00")).toBe("2026-05-18T06:15:00+02:00");
  });

  it("keeps a Z marker", () => {
    expect(reformatPegelTime("2026-05-18T06:15:00Z")).toBe("2026-05-18T06:15:00Z");
  });

  it("handles a minute-only stamp with offset", () => {
    expect(reformatPegelTime("2026-05-18T06:15+0200")).toBe("2026-05-18T06:15+0200");
  });

  it("returns the input unchanged when it carries no zone marker", () => {
    expect(reformatPegelTime("2026-05-18T06:15:00")).toBe("2026-05-18T06:15:00");
  });
});

describe("fetchMeasurements", () => {
  it("downsamples to every 15th sample of the minute-resolution series", async () => {
    const raw = Array.from({ length: 31 }, (_, i) => ({
      timestamp: `2026-05-18T06:${String(i).padStart(2, "0")}:00+02:00`,
      value: 100 + i,
    }));
    mockFetch.mockResolvedValueOnce(mockOk(raw));

    const obs = await fetchMeasurements("uuid-1");

    // Keeps indices 0, 15, 30.
    expect(obs.map((p) => p.value)).toEqual([100, 115, 130]);
  });

  it("returns an empty array when the upstream call fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    expect(await fetchMeasurements("uuid-1")).toEqual([]);
  });
});

describe("deriveExtrema", () => {
  it("derives a high from a rise-then-fall curve and converts centimetres to feet", () => {
    const curve = [
      { time: "2026-05-18T00:00:00+02:00", valueCm: 100 },
      { time: "2026-05-18T00:30:00+02:00", valueCm: 130 },
      { time: "2026-05-18T01:00:00+02:00", valueCm: 160 },
      { time: "2026-05-18T01:30:00+02:00", valueCm: 190 },
      { time: "2026-05-18T02:00:00+02:00", valueCm: 200 },
      { time: "2026-05-18T02:30:00+02:00", valueCm: 170 },
      { time: "2026-05-18T03:00:00+02:00", valueCm: 140 },
      { time: "2026-05-18T03:30:00+02:00", valueCm: 110 },
    ];

    const events = deriveExtrema(curve);

    // 200 cm peak → 200 * 0.0328084 = 6.56168 ≈ 6.56 ft.
    expect(events).toEqual([{ time: "2026-05-18T02:00:00+02:00", type: "H", valueFt: 6.56 }]);
  });

  it("returns no events for a flat (noise-only) series", () => {
    const flat = Array.from({ length: 8 }, (_, i) => ({
      time: `2026-05-18T0${i}:00:00+02:00`,
      valueCm: 150,
    }));
    expect(deriveExtrema(flat)).toEqual([]);
  });
});
