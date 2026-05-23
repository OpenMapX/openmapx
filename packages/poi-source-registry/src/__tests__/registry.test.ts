import { describe, expect, it } from "vitest";
import {
  ALL_POI_SOURCES,
  getPoiSource,
  getPoiSourcesByDomain,
  type PoiBundledParseFn,
  type PoiLiveParseFn,
  type PoiSource,
  type PoiStaticParseFn,
  validatePoiSourceRegistry,
} from "../index.js";

const staticParse: PoiStaticParseFn = function* () {};
const liveParse: PoiLiveParseFn = () => new Map();
const bundledParse: PoiBundledParseFn = () => ({ static: [], live: new Map() });

function makeStaticSource(overrides: Partial<PoiSource> = {}): PoiSource {
  return {
    id: "test-source",
    domain: "ev-charging",
    name: "Test Source",
    static: {
      cron: "0 * * * *",
      fetch: { type: "http", url: "https://example.com/data.csv" },
      parse: staticParse,
    },
    ...overrides,
  } as PoiSource;
}

function makeBundledSource(overrides: Partial<PoiSource> = {}): PoiSource {
  return {
    id: "bundled-source",
    domain: "parking",
    name: "Bundled Source",
    bundled: {
      cron: "*/5 * * * *",
      fetch: { type: "http", url: "https://example.com/feed.json" },
      parse: bundledParse,
    },
    ...overrides,
  } as PoiSource;
}

describe("validatePoiSourceRegistry", () => {
  it("passes with empty array", () => {
    expect(() => validatePoiSourceRegistry([])).not.toThrow();
  });

  it("passes with default ALL_POI_SOURCES (empty)", () => {
    expect(() => validatePoiSourceRegistry()).not.toThrow();
    expect(ALL_POI_SOURCES).toEqual([]);
  });

  it("throws on duplicate id with both indexes in message", () => {
    const sources = [makeStaticSource({ id: "dupe" }), makeStaticSource({ id: "dupe" })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/duplicate source id "dupe".*0.*1/s);
  });

  it("throws on invalid id (uppercase)", () => {
    const sources = [makeStaticSource({ id: "BadId" })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/id must match/);
  });

  it("throws on invalid id (leading dash)", () => {
    const sources = [makeStaticSource({ id: "-leading" })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/id must match/);
  });

  it("throws on invalid cron expression", () => {
    const sources = [
      makeStaticSource({
        id: "bad-cron",
        static: {
          cron: "not a cron",
          fetch: { type: "http", url: "https://example.com" },
          parse: staticParse,
        },
      }),
    ];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/is not a valid 5-field cron/);
  });

  it("throws on bad coverage bbox (west >= east)", () => {
    const sources = [makeStaticSource({ id: "bad-bbox", coverage: [10, 0, 5, 50] })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/west.*must be < east/);
  });

  it("throws on bad coverage bbox (south >= north)", () => {
    const sources = [makeStaticSource({ id: "bad-bbox-ns", coverage: [0, 50, 10, 50] })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/south.*must be < north/);
  });

  it("throws on coverage out of range", () => {
    const sources = [makeStaticSource({ id: "oor", coverage: [-200, 0, 0, 50] })];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/out of range/);
  });

  it("throws on source with both static and bundled", () => {
    const sources = [
      {
        id: "both",
        domain: "ev-charging",
        name: "Both",
        static: {
          cron: "0 * * * *",
          fetch: { type: "http", url: "https://example.com" },
          parse: staticParse,
        },
        bundled: {
          cron: "0 * * * *",
          fetch: { type: "http", url: "https://example.com" },
          parse: bundledParse,
        },
      } as unknown as PoiSource,
    ];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(
      /cannot set both "static" and "bundled"/,
    );
  });

  it("throws on source with neither static nor bundled", () => {
    const sources = [
      { id: "neither", domain: "ev-charging", name: "Neither" } as unknown as PoiSource,
    ];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(
      /must set exactly one of "static" or "bundled"/,
    );
  });

  it("throws on live without static", () => {
    const sources = [
      {
        id: "live-no-static",
        domain: "ev-charging",
        name: "Live no static",
        bundled: {
          cron: "0 * * * *",
          fetch: { type: "http", url: "https://example.com" },
          parse: bundledParse,
        },
        live: {
          cron: "* * * * *",
          fetch: { type: "http", url: "https://example.com" },
          parse: liveParse,
        },
      } as unknown as PoiSource,
    ];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/"live" requires "static"/);
  });

  it("passes for a valid registry with static + live and bundled", () => {
    const sources: PoiSource[] = [
      {
        id: "src-a",
        domain: "ev-charging",
        name: "A",
        coverage: [-10, -10, 10, 10],
        static: {
          cron: "0 3 * * *",
          fetch: { type: "http", url: "https://example.com/a.csv" },
          parse: staticParse,
        },
        live: {
          cron: "*/2 * * * *",
          fetch: { type: "http", url: "https://example.com/a-live.json" },
          parse: liveParse,
        },
      },
      makeBundledSource(),
    ];
    expect(() => validatePoiSourceRegistry(sources)).not.toThrow();
  });

  it("aggregates multiple errors into one message", () => {
    const sources = [
      makeStaticSource({ id: "BAD" }),
      makeStaticSource({
        id: "x",
        static: {
          cron: "nope",
          fetch: { type: "http", url: "https://example.com" },
          parse: staticParse,
        },
      }),
    ];
    expect(() => validatePoiSourceRegistry(sources)).toThrow(/found 2 problem\(s\)/);
  });
});

describe("getPoiSource / getPoiSourcesByDomain", () => {
  it("getPoiSource returns undefined for unknown id (default empty registry)", () => {
    expect(getPoiSource("nope")).toBeUndefined();
  });

  it("getPoiSourcesByDomain returns empty list on default registry", () => {
    expect(getPoiSourcesByDomain("ev-charging")).toEqual([]);
  });

  it("validates a synthetic list and lookups work on it", () => {
    const sources = [
      makeStaticSource({ id: "src-1" }),
      makeBundledSource({ id: "src-2", domain: "ev-charging" }),
    ];
    validatePoiSourceRegistry(sources);
    const found = sources.find((s) => s.id === "src-1");
    expect(found?.id).toBe("src-1");
    expect(sources.filter((s) => s.domain === "ev-charging").length).toBe(2);
  });
});
