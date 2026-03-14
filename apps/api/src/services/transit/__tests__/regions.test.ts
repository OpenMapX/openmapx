import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the registry import
vi.mock("../registry/index.js", () => ({
  registry: {
    initialized: false,
    findByPrefix: vi.fn(() => null),
    findProviders: vi.fn(() => []),
  },
}));

import {
  bboxToCenter,
  dynamicEntryFromId,
  getDynamicProviders,
  getRegionalProviders,
  providerFromId,
} from "../regions.js";
import { registry } from "../registry/index.js";

describe("getRegionalProviders", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns DB for a bbox covering Germany", () => {
    const bbox: [number, number, number, number] = [10, 50, 12, 52];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("db");
  });

  it("returns iRail for a bbox covering Belgium", () => {
    const bbox: [number, number, number, number] = [3, 50, 5, 51];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("irail");
  });

  it("returns opendata-ch for a bbox covering Switzerland", () => {
    const bbox: [number, number, number, number] = [7, 46, 9, 47];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("opendata-ch");
  });

  it("returns empty array for a bbox in Africa (no coverage)", () => {
    const bbox: [number, number, number, number] = [30, -5, 35, 0];
    const providers = getRegionalProviders(bbox);
    expect(providers).toHaveLength(0);
  });

  it("returns TfL for London bbox when TFL_API_KEY is set", () => {
    process.env.TFL_API_KEY = "test-key";
    const bbox: [number, number, number, number] = [-0.2, 51.4, 0.1, 51.6];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("tfl");
  });

  it("skips TfL for London bbox when TFL_API_KEY is not set", () => {
    delete process.env.TFL_API_KEY;
    const bbox: [number, number, number, number] = [-0.2, 51.4, 0.1, 51.6];
    const providers = getRegionalProviders(bbox);
    expect(providers).not.toContain("tfl");
  });

  it("returns MBTA for Boston bbox when MBTA_API_KEY is set", () => {
    process.env.MBTA_API_KEY = "test-key";
    const bbox: [number, number, number, number] = [-71.2, 42.2, -70.8, 42.5];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("mbta");
  });

  it("skips DB when query bbox is entirely within VBB region", () => {
    // Berlin center — fully within VBB bbox
    const bbox: [number, number, number, number] = [13.3, 52.4, 13.5, 52.6];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("vbb");
    expect(providers).not.toContain("db");
  });

  it("keeps DB when query bbox extends beyond VBB region", () => {
    // Large bbox covering both Berlin and rest of Germany
    const bbox: [number, number, number, number] = [8, 48, 15, 55];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("vbb");
    expect(providers).toContain("db");
  });

  it("returns VBB for Berlin center (BVG is not in REGIONS list — uses HAFAS instances instead)", () => {
    const bbox: [number, number, number, number] = [13.3, 52.45, 13.5, 52.55];
    const providers = getRegionalProviders(bbox);
    expect(providers).toContain("vbb");
    // BVG is handled via HAFAS_INSTANCES, not via regional providers
    expect(providers).not.toContain("bvg");
  });
});

describe("bboxToCenter", () => {
  it("computes center lat/lng from bbox", () => {
    const result = bboxToCenter([10, 50, 12, 52]);
    expect(result.lat).toBeCloseTo(51);
    expect(result.lng).toBeCloseTo(11);
  });

  it("computes a positive radius", () => {
    const result = bboxToCenter([10, 50, 12, 52]);
    expect(result.radiusMeters).toBeGreaterThan(0);
  });

  it("returns small radius for small bbox", () => {
    const result = bboxToCenter([13.39, 52.51, 13.41, 52.53]);
    expect(result.radiusMeters).toBeLessThan(5000);
  });
});

describe("providerFromId", () => {
  it("maps tfl: prefix to tfl", () => {
    expect(providerFromId("tfl:12345")).toBe("tfl");
  });

  it("maps ir: prefix to irail", () => {
    expect(providerFromId("ir:ABCD")).toBe("irail");
  });

  it("maps mb: prefix to mbta", () => {
    expect(providerFromId("mb:place-south")).toBe("mbta");
  });

  it("maps ch: prefix to opendata-ch", () => {
    expect(providerFromId("ch:8500010")).toBe("opendata-ch");
  });

  it("maps db: prefix to db", () => {
    expect(providerFromId("db:8011160")).toBe("db");
  });

  it("maps vbb: prefix to vbb", () => {
    expect(providerFromId("vbb:900000100001")).toBe("vbb");
  });

  it("maps bvg: prefix to bvg", () => {
    expect(providerFromId("bvg:900000100001")).toBe("bvg");
  });

  it("returns null for unknown prefix", () => {
    expect(providerFromId("xyz:12345")).toBeNull();
  });

  it("returns null for unprefixed ID", () => {
    expect(providerFromId("12345")).toBeNull();
  });
});

describe("dynamicEntryFromId", () => {
  it("returns null when registry is not initialized", () => {
    vi.mocked(registry).initialized = false;
    expect(dynamicEntryFromId("oebb:12345")).toBeNull();
  });

  it("delegates to registry.findByPrefix when initialized", () => {
    vi.mocked(registry).initialized = true;
    const mockEntry = { id: "at/oebb", prefix: "oebb:" } as ReturnType<
      typeof registry.findByPrefix
    > &
      object;
    vi.mocked(registry.findByPrefix).mockReturnValue(mockEntry);

    const result = dynamicEntryFromId("oebb:12345");
    expect(registry.findByPrefix).toHaveBeenCalledWith("oebb:");
    expect(result).toBe(mockEntry);
  });

  it("returns null for ID without colon", () => {
    vi.mocked(registry).initialized = true;
    expect(dynamicEntryFromId("12345")).toBeNull();
  });

  it("returns null for ID starting with colon", () => {
    vi.mocked(registry).initialized = true;
    expect(dynamicEntryFromId(":12345")).toBeNull();
  });
});

describe("getDynamicProviders", () => {
  it("returns empty array when registry is not initialized", () => {
    vi.mocked(registry).initialized = false;
    expect(getDynamicProviders([10, 50, 12, 52])).toEqual([]);
  });

  it("delegates to registry.findProviders when initialized", () => {
    vi.mocked(registry).initialized = true;
    vi.mocked(registry.findProviders).mockReturnValue([]);

    const bbox: [number, number, number, number] = [10, 50, 12, 52];
    getDynamicProviders(bbox);
    expect(registry.findProviders).toHaveBeenCalledWith(bbox);
  });
});
