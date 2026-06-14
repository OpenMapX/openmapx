import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CachedStation, fetchCurve, fetchHilo, isoTimeFromKartverket } from "../index.js";

// Kartverket Sehavnivå returns tide data as XML with values in centimetres
// (referenced to chart datum) and timestamps carrying a UTC offset. These tests
// pin the offset-preserving timestamp parse, the `<waterlevel>` XML extraction,
// the flag→type mapping, and the centimetres→feet conversion (`CM_TO_FT`).

const STATION: CachedStation = {
  code: "TRG",
  name: "Tromsø",
  lat: 69.6489,
  lng: 18.9551,
};

function mockText(xml: string) {
  return { ok: true, status: 200, text: async () => xml } as Response;
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

describe("isoTimeFromKartverket", () => {
  it("keeps the UTC offset so the place panel renders browser-local time", () => {
    expect(isoTimeFromKartverket("2026-05-18T05:24:00+01:00")).toBe("2026-05-18T05:24:00+01:00");
  });

  it("keeps a Z marker", () => {
    expect(isoTimeFromKartverket("2026-05-18T05:24:00Z")).toBe("2026-05-18T05:24:00Z");
  });

  it("handles a minute-only stamp with offset", () => {
    expect(isoTimeFromKartverket("2026-05-18T05:24+0100")).toBe("2026-05-18T05:24+0100");
  });

  it("returns the input unchanged when it carries no zone marker", () => {
    expect(isoTimeFromKartverket("2026-05-18T05:24:00")).toBe("2026-05-18T05:24:00");
  });
});

describe("fetchHilo", () => {
  it("maps high/low flags to H/L and converts centimetres to feet", async () => {
    mockFetch.mockResolvedValueOnce(
      mockText(
        `<tide>
          <locationdata>
            <waterlevel value="250.0" time="2026-05-18T05:24:00+01:00" flag="high"/>
            <waterlevel value="14.3" time="2026-05-18T11:38:00+01:00" flag="low"/>
            <waterlevel value="248.0" time="2026-05-18T17:51:00+01:00" flag="high"/>
          </locationdata>
        </tide>`,
      ),
    );

    const events = await fetchHilo(STATION);

    expect(events).toEqual([
      { time: "2026-05-18T05:24:00+01:00", type: "H", valueFt: 8.2 },
      { time: "2026-05-18T11:38:00+01:00", type: "L", valueFt: 0.47 },
      { time: "2026-05-18T17:51:00+01:00", type: "H", valueFt: 8.14 },
    ]);
  });

  it("handles negative levels (below chart datum)", async () => {
    mockFetch.mockResolvedValueOnce(
      mockText(`<waterlevel value="-50.0" time="2026-05-18T11:38:00+01:00" flag="low"/>`),
    );

    const events = await fetchHilo(STATION);

    expect(events).toEqual([{ time: "2026-05-18T11:38:00+01:00", type: "L", valueFt: -1.64 }]);
  });

  it("returns an empty array when the upstream request fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    expect(await fetchHilo(STATION)).toEqual([]);
  });

  it("ignores curve (flag=pre) entries when reading high/low events", async () => {
    mockFetch.mockResolvedValueOnce(
      mockText(`<waterlevel value="100.0" time="2026-05-18T00:00:00+01:00" flag="pre"/>`),
    );
    expect(await fetchHilo(STATION)).toEqual([]);
  });
});

describe("fetchCurve", () => {
  it("reads only flag=pre samples and converts centimetres to feet", async () => {
    mockFetch.mockResolvedValueOnce(
      mockText(
        `<tide>
          <waterlevel value="100.0" time="2026-05-18T00:00:00+01:00" flag="pre"/>
          <waterlevel value="120.0" time="2026-05-18T00:30:00+01:00" flag="pre"/>
          <waterlevel value="250.0" time="2026-05-18T05:24:00+01:00" flag="high"/>
        </tide>`,
      ),
    );

    const curve = await fetchCurve(STATION);

    expect(curve).toEqual([
      { time: "2026-05-18T00:00:00+01:00", valueFt: 3.28 },
      { time: "2026-05-18T00:30:00+01:00", valueFt: 3.94 },
    ]);
  });

  it("returns an empty array when the upstream request fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    expect(await fetchCurve(STATION)).toEqual([]);
  });
});
