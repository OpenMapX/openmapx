import type { Attribution } from "@openmapx/mobility-core/attribution";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnturClient } from "../client";
import type { EnturGeocoderFeature } from "./client";
import { createEnturGeocoder, type EnturGeocoderSource } from "./client";
import { createEnturGeocoderSources, ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS } from "./sources";

function feature(
  properties: Partial<EnturGeocoderFeature["properties"]> = {},
): EnturGeocoderFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [10, 60] },
    properties: {
      id: "NSR:StopPlace:337",
      names: { default: "Oslo S", display: "Oslo S, Oslo" },
      layer: "stopPlace",
      source: "nsr",
      ...properties,
    },
  };
}

const signal = () => new AbortController().signal;
const receipt = (sourceId: string): Attribution => ({
  sourceId,
  name: sourceId,
  publisher: { name: "Original" },
});
const all = () =>
  Object.fromEntries(
    ["entur-geocoder", ...Object.values(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS)].map((id) => [
      id,
      [receipt(id)],
    ]),
  );
afterEach(() => vi.useRealTimers());
describe("captured geocoder supplier policy", () => {
  it.each([
    "nsr",
    "openstreetmap",
    "kartverket-matrikkelenadresse",
    "kartverket-stedsnavn",
    "custom-poi",
  ] as const)("captures API and exact %s supplier only", (source) => {
    const contributors = all();
    const sources = createEnturGeocoderSources({ contributors, isSourceAllowed: async () => true });
    const publisher = contributors[ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source]][0].publisher;
    if (!publisher) throw new Error("Expected publisher");
    publisher.name = "Changed";
    expect(sources.contributorsFor(feature({ source })).map((r) => r.sourceId)).toEqual([
      "entur-geocoder",
      ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source],
    ]);
    expect(sources.contributorsFor(feature({ source }))[1].publisher?.name).toBe("Original");
    expect(Object.isFrozen(sources.contributorsFor(feature({ source }))[1].publisher)).toBe(true);
  });
  it("uses own authoritative empty declarations, excluding absent and inherited supplier keys", async () => {
    const contributors = Object.assign(Object.create({ "entur-geocoder-osm": [] }), {
      "entur-geocoder": [],
      "entur-geocoder-nsr": [],
    });
    const checked: string[] = [];
    const sources = createEnturGeocoderSources({
      contributors,
      isSourceAllowed: async (id) => {
        checked.push(id);
        return true;
      },
    });
    expect(await sources.allowedSources(signal())).toEqual(["nsr"]);
    expect(checked).toEqual(["entur-geocoder-nsr"]);
    expect(sources.contributorsFor(feature())).toEqual([]);
    expect(() => sources.contributorsFor(feature({ source: "openstreetmap" }))).toThrow();
  });
  it("rechecks revocation rather than caching permission", async () => {
    let denied = false;
    const sources = createEnturGeocoderSources({
      contributors: all(),
      isSourceAllowed: async (id) => !(denied && id === "entur-geocoder-nsr"),
    });
    expect(await sources.allowedSources(signal())).toContain("nsr");
    denied = true;
    expect(await sources.allowedSources(signal())).not.toContain("nsr");
  });
  it.each([
    ["NSR:StopPlace:337", "nsr"],
    ["NSR:GroupOfStopPlaces:1", "nsr"],
    ["OSM:TopographicPlace:2", "openstreetmap"],
    ["KVE:PostalAddress:1", "kartverket-matrikkelenadresse"],
    ["KVE:PlaceName:1", "kartverket-stedsnavn"],
  ] as const)("checks exact native ownership for %s", async (id, source) => {
    const sources = createEnturGeocoderSources({
      contributors: all(),
      isSourceAllowed: async () => true,
    });
    await expect(sources.assertLookupAllowed([id], [source], signal())).resolves.toBeUndefined();
    await expect(sources.assertLookupAllowed([id], [], signal())).rejects.toMatchObject({
      kind: "policy",
    });
  });
  it.each(["225678815", "KVE:TopographicPlace:0301", "CUSTOM:Place:1", "unknown"])(
    "fails closed for ambiguous ownership %s unless all possible suppliers are allowed",
    async (id) => {
      const sources = createEnturGeocoderSources({
        contributors: all(),
        isSourceAllowed: async () => true,
      });
      await expect(sources.assertLookupAllowed([id], ["nsr"], signal())).rejects.toMatchObject({
        kind: "policy",
      });
      await expect(
        sources.assertLookupAllowed(
          [id],
          Object.keys(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS) as EnturGeocoderSource[],
          signal(),
        ),
      ).resolves.toBeUndefined();
      const partial = createEnturGeocoderSources({
        contributors: { "entur-geocoder-nsr": [] },
        isSourceAllowed: async () => true,
      });
      await expect(
        partial.assertLookupAllowed(
          [id],
          Object.keys(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS) as EnturGeocoderSource[],
          signal(),
        ),
      ).rejects.toMatchObject({ kind: "policy" });
    },
  );
  it("SDK rejects revoked result and bounds a supplier callback that never settles", async () => {
    vi.useFakeTimers();
    let denied = false;
    const policy = createEnturGeocoderSources({
      contributors: all(),
      isSourceAllowed: async (id) => !(denied && id === "entur-geocoder-nsr"),
    });
    const getJson = vi.fn(async () => {
      denied = true;
      return {
        type: "FeatureCollection",
        features: [feature()],
        metadata: {
          query: { limit: 1, lang: "en" },
          resultCount: 1,
          timestamp: "2026-10-19T10:00:00Z",
        },
      };
    });
    const client = {
      getJson,
      assertSourceAllowed: async () => undefined,
    } as unknown as EnturClient;
    await expect(
      createEnturGeocoder(client, { policy }).autocomplete({ q: "Oslo" }, signal()),
    ).rejects.toMatchObject({ kind: "policy" });
    const stalled = createEnturGeocoderSources({
      contributors: all(),
      isSourceAllowed: () => new Promise(() => {}),
    });
    const pending = createEnturGeocoder(client, { policy: stalled, timeoutMs: 20 }).autocomplete(
      { q: "Oslo" },
      signal(),
    );
    const outcome = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(20);
    await outcome;
    expect(getJson).toHaveBeenCalledOnce();
  });
});
