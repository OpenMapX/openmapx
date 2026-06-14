import type { Logger } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchHighLowPredictions,
  fetchLatestMet,
  fetchLatestWaterLevel,
  fetchTideCurve,
} from "../datagetter.js";

// A no-op Logger that records calls so we can assert warn/debug paths without
// real I/O. `debug` is optional in the real Logger shape but always present
// here; the source guards it with `log.debug?.(...)`.
function makeLogger(): Logger & {
  calls: { level: string; message: string }[];
} {
  const calls: { level: string; message: string }[] = [];
  return {
    calls,
    info: (m: string) => calls.push({ level: "info", message: m }),
    warn: (m: string) => calls.push({ level: "warn", message: m }),
    error: (m: string) => calls.push({ level: "error", message: m }),
    debug: (m: string) => calls.push({ level: "debug", message: m }),
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Extract the `begin_date=YYYYMMDD` value from the URL the source built.
function beginDateFromCall(call: unknown[]): string {
  const url = new URL(call[0] as string);
  return url.searchParams.get("begin_date") ?? "";
}

describe("utcDateMinusOneDay (via begin_date param)", () => {
  it("steps back one UTC day at midday UTC", async () => {
    // 2025-06-14 12:00 UTC -> yesterday-UTC = 2025-06-13.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-14T12:00:00.000Z"));
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    expect(beginDateFromCall(mockFetch.mock.calls[0])).toBe("20250613");
  });

  it("pins the late-evening US local boundary where UTC has rolled to tomorrow", async () => {
    // 2025-06-15 02:30 UTC == 2025-06-14 22:30 EDT (UTC-4). For an EDT user it
    // is still the evening of the 14th, but UTC already shows the 15th. The
    // helper steps back to 2025-06-14 (UTC), which together with range=72h
    // keeps tonight's still-future events inside the window (the regression the
    // doc-comment warns about: a plain begin_date=todayUTC=15th would drop them).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-15T02:30:00.000Z"));
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    expect(beginDateFromCall(mockFetch.mock.calls[0])).toBe("20250614");
  });

  it("crosses a month boundary correctly (UTC 1st -> previous month last day)", async () => {
    // 2025-07-01 00:30 UTC minus 24h -> 2025-06-30.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-07-01T00:30:00.000Z"));
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    expect(beginDateFromCall(mockFetch.mock.calls[0])).toBe("20250630");
  });

  it("crosses a year boundary correctly (UTC Jan 1 -> Dec 31 prior year)", async () => {
    // 2026-01-01 00:00 UTC minus 24h -> 2025-12-31.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    expect(beginDateFromCall(mockFetch.mock.calls[0])).toBe("20251231");
  });

  it("zero-pads single-digit months and days", async () => {
    // 2025-03-09 06:00 UTC minus 24h -> 2025-03-08 (both single digit).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-03-09T06:00:00.000Z"));
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    expect(beginDateFromCall(mockFetch.mock.calls[0])).toBe("20250308");
  });
});

describe("fetchHighLowPredictions", () => {
  it("maps a predictions array to TideEvent[] with numeric coercion", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        predictions: [
          { t: "2025-06-14 03:12", v: "1.234", type: "L" },
          { t: "2025-06-14 09:45", v: "4.560", type: "H" },
        ],
      }),
    );

    const result = await fetchHighLowPredictions("9410230", makeLogger());

    expect(result).toEqual([
      { time: "2025-06-14 03:12", type: "L", valueFt: 1.234 },
      { time: "2025-06-14 09:45", type: "H", valueFt: 4.56 },
    ]);
  });

  it("defaults an unknown/missing type to 'H'", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        predictions: [
          { t: "2025-06-14 03:12", v: "1.0", type: "X" },
          { t: "2025-06-14 09:45", v: "2.0" },
        ],
      }),
    );

    const result = await fetchHighLowPredictions("9410230", makeLogger());

    expect(result?.map((e) => e.type)).toEqual(["H", "H"]);
  });

  it("drops non-finite values (empty string, NaN, missing v)", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        predictions: [
          { t: "a", v: "", type: "H" },
          { t: "b", v: "not-a-number", type: "L" },
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
          { t: "c", type: "H" } as any,
          { t: "d", v: "2.5", type: "L" },
        ],
      }),
    );

    const result = await fetchHighLowPredictions("9410230", makeLogger());

    expect(result).toEqual([{ time: "d", type: "L", valueFt: 2.5 }]);
  });

  it("returns [] when predictions is missing entirely", async () => {
    mockFetch.mockResolvedValue(okJson({}));

    const result = await fetchHighLowPredictions("9410230", makeLogger());

    expect(result).toEqual([]);
  });

  it("returns null and warns on an error-shaped response", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue(okJson({ error: { message: "Wrong Date" } }));

    const result = await fetchHighLowPredictions("9410230", log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === "warn" && c.message.includes("Wrong Date"))).toBe(
      true,
    );
  });

  it("returns null and warns on a non-ok HTTP status", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);

    const result = await fetchHighLowPredictions("9410230", log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === "warn" && c.message.includes("503"))).toBe(true);
  });

  it("returns null and warns when fetch fails (timeout/abort -> null response)", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue(null);

    const result = await fetchHighLowPredictions("9410230", log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === "warn" && c.message.includes("fetch failed"))).toBe(
      true,
    );
  });

  it("sends the documented hilo/predictions request params", async () => {
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchHighLowPredictions("9410230", makeLogger());

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("station")).toBe("9410230");
    expect(url.searchParams.get("product")).toBe("predictions");
    expect(url.searchParams.get("interval")).toBe("hilo");
    expect(url.searchParams.get("range")).toBe("72");
    expect(url.searchParams.get("time_zone")).toBe("lst_ldt");
    expect(url.searchParams.get("format")).toBe("json");
  });
});

describe("fetchTideCurve", () => {
  it("maps every prediction to a TideEvent with constant type 'H'", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        predictions: [
          { t: "2025-06-14 00:00", v: "1.1" },
          { t: "2025-06-14 00:30", v: "1.4" },
          { t: "2025-06-14 01:00", v: "1.7" },
        ],
      }),
    );

    const result = await fetchTideCurve("9410230", makeLogger());

    expect(result).toEqual([
      { time: "2025-06-14 00:00", type: "H", valueFt: 1.1 },
      { time: "2025-06-14 00:30", type: "H", valueFt: 1.4 },
      { time: "2025-06-14 01:00", type: "H", valueFt: 1.7 },
    ]);
  });

  it("drops malformed numeric samples from the curve", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        predictions: [
          { t: "a", v: "2.0" },
          { t: "b", v: "" },
          { t: "c", v: "x" },
          { t: "d", v: "3.0" },
        ],
      }),
    );

    const result = await fetchTideCurve("9410230", makeLogger());

    expect(result?.map((e) => e.time)).toEqual(["a", "d"]);
  });

  it("honors the hours arg as the range param", async () => {
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchTideCurve("9410230", makeLogger(), 24);

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("range")).toBe("24");
    expect(url.searchParams.get("interval")).toBe("30");
  });

  it("defaults the range to 48 hours when hours is omitted", async () => {
    mockFetch.mockResolvedValue(okJson({ predictions: [] }));

    await fetchTideCurve("9410230", makeLogger());

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("range")).toBe("48");
  });

  it("returns null (no warn) on an error-shaped response", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue(okJson({ error: { message: "No data" } }));

    const result = await fetchTideCurve("9410230", log);

    expect(result).toBeNull();
  });

  it("returns null when fetch is not ok", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    const result = await fetchTideCurve("9410230", log);

    expect(result).toBeNull();
    expect(
      log.calls.some((c) => c.level === "warn" && c.message.includes("curve fetch failed")),
    ).toBe(true);
  });

  it("returns null when fetch returns null (timeout)", async () => {
    mockFetch.mockResolvedValue(null);

    const result = await fetchTideCurve("9410230", makeLogger());

    expect(result).toBeNull();
  });
});

describe("fetchLatestWaterLevel", () => {
  it("returns the LAST data sample mapped to a WaterLevelReading", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        data: [
          { t: "2025-06-14 12:00", v: "1.10", q: "p" },
          { t: "2025-06-14 12:06", v: "1.20", q: "p" },
          { t: "2025-06-14 12:12", v: "1.30", q: "v" },
        ],
      }),
    );

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    expect(result).toEqual({ time: "2025-06-14 12:12", valueFt: 1.3, quality: "v" });
  });

  it("preserves the preliminary quality flag", async () => {
    mockFetch.mockResolvedValue(okJson({ data: [{ t: "t", v: "0.5", q: "p" }] }));

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    expect(result?.quality).toBe("p");
  });

  it("returns null when the latest sample has a non-finite value", async () => {
    mockFetch.mockResolvedValue(
      okJson({
        data: [
          { t: "t1", v: "1.0", q: "v" },
          { t: "t2", v: "", q: "p" },
        ],
      }),
    );

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    // Only the LAST sample is considered; its empty value -> null overall.
    expect(result).toBeNull();
  });

  it("returns null when data is empty", async () => {
    mockFetch.mockResolvedValue(okJson({ data: [] }));

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    expect(result).toBeNull();
  });

  it("returns null when data is missing", async () => {
    mockFetch.mockResolvedValue(okJson({}));

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    expect(result).toBeNull();
  });

  it("returns null and debug-logs on an error-shaped response", async () => {
    const log = makeLogger();
    mockFetch.mockResolvedValue(okJson({ error: { message: "No water level" } }));

    const result = await fetchLatestWaterLevel("9410230", log);

    expect(result).toBeNull();
    expect(log.calls.some((c) => c.level === "debug" && c.message.includes("No water level"))).toBe(
      true,
    );
  });

  it("returns null when fetch is not ok", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);

    const result = await fetchLatestWaterLevel("9410230", makeLogger());

    expect(result).toBeNull();
  });

  it("does not throw when the logger has no debug method", async () => {
    const noDebugLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as Logger;
    mockFetch.mockResolvedValue(okJson({ error: { message: "nope" } }));

    const result = await fetchLatestWaterLevel("9410230", noDebugLog);

    expect(result).toBeNull();
  });

  it("requests product=water_level with date=latest", async () => {
    mockFetch.mockResolvedValue(okJson({ data: [] }));

    await fetchLatestWaterLevel("9410230", makeLogger());

    const url = new URL(mockFetch.mock.calls[0][0] as string);
    expect(url.searchParams.get("product")).toBe("water_level");
    expect(url.searchParams.get("date")).toBe("latest");
  });
});

describe("fetchLatestMet", () => {
  // Map each met product to a representative latest-sample payload. The source
  // fires four fetches (wind, air_pressure, water_temperature, air_temperature)
  // in product order via Promise.all, so we key responses off the `product=`
  // query param to stay order-independent.
  function metRouter(byProduct: Record<string, unknown>) {
    return async (input: string) => {
      const product = new URL(input).searchParams.get("product") ?? "";
      const body = byProduct[product];
      if (body === undefined) return okJson({ error: { message: "Unsupported" } });
      return okJson(body);
    };
  }

  it("merges all four met products into a single MetReadings", async () => {
    mockFetch.mockImplementation(
      metRouter({
        wind: { data: [{ t: "2025-06-14 12:00", v: "10.5", d: "180", g: "15.2" }] },
        air_pressure: { data: [{ t: "2025-06-14 12:00", v: "1013.2" }] },
        water_temperature: { data: [{ t: "2025-06-14 12:00", v: "62.4" }] },
        air_temperature: { data: [{ t: "2025-06-14 12:00", v: "71.8" }] },
      }),
    );

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toEqual({
      time: "2025-06-14 12:00",
      windKnots: 10.5,
      windDirDeg: 180,
      windGustKnots: 15.2,
      pressureMb: 1013.2,
      waterTempF: 62.4,
      airTempF: 71.8,
    });
  });

  it("returns null when no product publishes data (all error-shaped)", async () => {
    mockFetch.mockResolvedValue(okJson({ error: { message: "Unsupported Station" } }));

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toBeNull();
  });

  it("returns a partial reading when only some products publish", async () => {
    mockFetch.mockImplementation(
      metRouter({
        water_temperature: { data: [{ t: "2025-06-14 12:00", v: "55.0" }] },
        // wind / air_pressure / air_temperature fall through to the error shape.
      }),
    );

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toEqual({ time: "2025-06-14 12:00", waterTempF: 55.0 });
  });

  it("skips a product whose primary value is non-finite", async () => {
    mockFetch.mockImplementation(
      metRouter({
        wind: { data: [{ t: "2025-06-14 12:00", v: "", d: "90" }] },
        air_temperature: { data: [{ t: "2025-06-14 12:00", v: "70" }] },
      }),
    );

    const result = await fetchLatestMet("9410230", makeLogger());

    // Wind value is empty -> windKnots is skipped; its direction is also not
    // applied because the switch is skipped via `continue`. time still set.
    expect(result).toEqual({ time: "2025-06-14 12:00", airTempF: 70 });
    expect(result?.windKnots).toBeUndefined();
    expect(result?.windDirDeg).toBeUndefined();
  });

  it("drops non-finite wind direction and gust but keeps wind speed", async () => {
    mockFetch.mockImplementation(
      metRouter({
        wind: { data: [{ t: "2025-06-14 12:00", v: "8.0", d: "", g: "bad" }] },
      }),
    );

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toEqual({ time: "2025-06-14 12:00", windKnots: 8.0 });
    expect(result?.windDirDeg).toBeUndefined();
    expect(result?.windGustKnots).toBeUndefined();
  });

  it("omits optional wind direction/gust when those fields are absent", async () => {
    mockFetch.mockImplementation(
      metRouter({
        wind: { data: [{ t: "2025-06-14 12:00", v: "12.0" }] },
      }),
    );

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toEqual({ time: "2025-06-14 12:00", windKnots: 12.0 });
  });

  it("returns null when a product's data array is empty", async () => {
    mockFetch.mockResolvedValue(okJson({ data: [] }));

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toBeNull();
  });

  it("ignores products whose fetch is not ok", async () => {
    mockFetch.mockImplementation(async (input: string) => {
      const product = new URL(input).searchParams.get("product") ?? "";
      if (product === "air_temperature") {
        return okJson({ data: [{ t: "2025-06-14 12:00", v: "68.0" }] });
      }
      return { ok: false, status: 500 } as unknown as Response;
    });

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toEqual({ time: "2025-06-14 12:00", airTempF: 68.0 });
  });

  it("returns null when every fetch fails (null responses)", async () => {
    mockFetch.mockResolvedValue(null);

    const result = await fetchLatestMet("9410230", makeLogger());

    expect(result).toBeNull();
  });
});
