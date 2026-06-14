import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCurve,
  fetchHiloEvents,
  fetchLatestObservation,
  normalizeIwlsTimestamp,
} from "../index.js";

// The DFO IWLS API returns water levels in metres at ISO-8601 UTC timestamps.
// These tests pin the two error-prone transforms: the metres→feet conversion
// (`M_TO_FT = 3.28084`, rounded to 2dp) and the high/low tagging of the hilo
// series, which the upstream endpoint leaves untyped (points alternate and are
// tagged by comparison with the adjacent value).

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

describe("normalizeIwlsTimestamp", () => {
  it("keeps the trailing Z so the place panel reads it as UTC", () => {
    expect(normalizeIwlsTimestamp("2026-05-18T03:20:00Z")).toBe("2026-05-18T03:20:00Z");
  });

  it("appends a Z when the upstream omits the marker", () => {
    expect(normalizeIwlsTimestamp("2026-05-18T03:20:00")).toBe("2026-05-18T03:20:00Z");
  });

  it("preserves a minute-only timestamp and tags it UTC", () => {
    expect(normalizeIwlsTimestamp("2026-05-18T03:20")).toBe("2026-05-18T03:20Z");
  });

  it("returns the input unchanged when it does not look like an ISO timestamp", () => {
    expect(normalizeIwlsTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("fetchHiloEvents", () => {
  it("tags alternating points H/L by comparison and converts metres to feet", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        { eventDate: "2026-05-18T03:20:00Z", value: 1.5 },
        { eventDate: "2026-05-18T09:35:00Z", value: 0.3 },
        { eventDate: "2026-05-18T15:50:00Z", value: 2.0 },
      ]),
    );

    const events = await fetchHiloEvents("5cebf1de3d0f4a073c4bbd92");

    expect(events).toEqual([
      { time: "2026-05-18T03:20:00Z", type: "H", valueFt: 4.92 },
      { time: "2026-05-18T09:35:00Z", type: "L", valueFt: 0.98 },
      { time: "2026-05-18T15:50:00Z", type: "H", valueFt: 6.56 },
    ]);
  });

  it("tags the final point by comparing against the previous one", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        { eventDate: "2026-05-18T03:20:00Z", value: 2.0 },
        { eventDate: "2026-05-18T09:35:00Z", value: 0.4 },
      ]),
    );

    const events = await fetchHiloEvents("s1");

    // p0 > next ⇒ H; final point < prev ⇒ L.
    expect(events.map((e) => e.type)).toEqual(["H", "L"]);
  });

  it("defaults a lone event to high (better for the next-high UI)", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([{ eventDate: "2026-05-18T03:20:00Z", value: 1.1 }]));

    const events = await fetchHiloEvents("s1");

    expect(events).toEqual([{ time: "2026-05-18T03:20:00Z", type: "H", valueFt: 3.61 }]);
  });

  it("returns an empty array for an empty or null response", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    expect(await fetchHiloEvents("s1")).toEqual([]);
  });
});

describe("fetchCurve", () => {
  it("maps every sample to feet, normalising timestamps", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        { eventDate: "2026-05-18T00:00:00", value: 1.0 },
        { eventDate: "2026-05-18T00:30:00Z", value: -0.5 },
      ]),
    );

    const curve = await fetchCurve("s1");

    expect(curve).toEqual([
      { time: "2026-05-18T00:00:00Z", valueFt: 3.28 },
      { time: "2026-05-18T00:30:00Z", valueFt: -1.64 },
    ]);
  });

  it("returns an empty array when the upstream call fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    expect(await fetchCurve("s1")).toEqual([]);
  });
});

describe("fetchLatestObservation", () => {
  it("returns the newest observed point converted to feet", async () => {
    mockFetch.mockResolvedValueOnce(
      mockOk([
        { eventDate: "2026-05-18T11:58:00Z", value: 1.23 },
        { eventDate: "2026-05-18T11:59:00Z", value: 1.27 },
        { eventDate: "2026-05-18T12:00:00Z", value: 1.31 },
      ]),
    );

    const obs = await fetchLatestObservation("s1");

    expect(obs).toEqual({ time: "2026-05-18T12:00:00Z", valueFt: 4.3 });
  });

  it("returns null when the station reports no recent observations", async () => {
    mockFetch.mockResolvedValueOnce(mockOk([]));
    expect(await fetchLatestObservation("s1")).toBeNull();
  });
});
