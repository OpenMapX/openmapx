import type { CategoryPlace } from "@openmapx/core";
import { apiClient } from "@openmapx/core";
import type { Map as MaplibreMap } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brandImageId,
  buildGeoJson,
  distinctBrandQids,
  loadBrandMarkerImage,
} from "../CategoryResultMarkers";

function place(id: string, osmTags?: Record<string, string>): CategoryPlace {
  return { id, name: id, coordinates: [0, 0], osmTags } as CategoryPlace;
}

describe("distinctBrandQids", () => {
  it("collects each brand QID once", () => {
    expect(
      distinctBrandQids([
        place("a", { "brand:wikidata": "Q1" }),
        place("b", { "brand:wikidata": "Q1" }),
        place("c", { "brand:wikidata": "Q2" }),
      ]),
    ).toEqual(["Q1", "Q2"]);
  });

  it("reads operator and network QIDs too", () => {
    expect(
      distinctBrandQids([
        place("a", { "operator:wikidata": "Q3" }),
        place("b", { "network:wikidata": "Q4" }),
      ]),
    ).toEqual(["Q3", "Q4"]);
  });

  it("prefers the brand QID when a place carries more than one", () => {
    expect(
      distinctBrandQids([place("a", { "brand:wikidata": "Q1", "operator:wikidata": "Q9" })]),
    ).toEqual(["Q1"]);
  });

  it("ignores places with no brand identity", () => {
    expect(distinctBrandQids([place("a"), place("b", { amenity: "cafe" })])).toEqual([]);
  });

  it("rejects values that are not QIDs", () => {
    expect(distinctBrandQids([place("a", { "brand:wikidata": "not-a-qid" })])).toEqual([]);
  });
});

describe("brandImageId", () => {
  it("namespaces the id so it cannot collide with a category image", () => {
    expect(brandImageId("Q1")).toBe("brand-marker-Q1");
  });
});

describe("buildGeoJson", () => {
  const FALLBACK = "category-marker-supermarket";

  it("uses the fallback image for a place with no brand identity", () => {
    const geojson = buildGeoJson([place("a")], FALLBACK, new Set(["brand-marker-Q1"]));
    expect(geojson.features[0].properties.imageId).toBe(FALLBACK);
  });

  it("uses the fallback image when the place's QID has not resolved to an image", () => {
    // Q1 is a real brand identity, but its logo either has none or failed to
    // load — the caller only ever adds a QID's image id to brandImageIds once
    // `loadBrandMarkerImage` resolved `true` for it, so an unresolved QID here
    // must degrade to the fallback marker exactly like "no brand" does.
    const geojson = buildGeoJson(
      [place("a", { "brand:wikidata": "Q1" })],
      FALLBACK,
      new Set(["brand-marker-Q2"]),
    );
    expect(geojson.features[0].properties.imageId).toBe(FALLBACK);
  });

  it("uses the resolved brand image for a place whose QID is in brandImageIds", () => {
    const geojson = buildGeoJson(
      [place("a", { "brand:wikidata": "Q1" })],
      FALLBACK,
      new Set([brandImageId("Q1")]),
    );
    expect(geojson.features[0].properties.imageId).toBe(brandImageId("Q1"));
  });
});

describe("loadBrandMarkerImage", () => {
  let addImage: ReturnType<typeof vi.fn>;
  let hasImage: ReturnType<typeof vi.fn>;
  let map: MaplibreMap;
  let imageOutcome: "load" | "error";

  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(
      public width?: number,
      public height?: number,
    ) {}
    set src(_value: string) {
      queueMicrotask(() => {
        if (imageOutcome === "load") this.onload?.();
        else this.onerror?.();
      });
    }
  }

  beforeEach(() => {
    imageOutcome = "load";
    hasImage = vi.fn().mockReturnValue(false);
    addImage = vi.fn();
    map = { hasImage, addImage } as unknown as MaplibreMap;
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves true without any request when the image is already registered", async () => {
    hasImage.mockReturnValue(true);
    const spy = vi.spyOn(apiClient, "get");

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolves false without registering an image when the brand-detail fetch throws", async () => {
    vi.spyOn(apiClient, "get").mockRejectedValue(new Error("404"));

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(false);
    expect(addImage).not.toHaveBeenCalled();
  });

  it("resolves false without fetching a logo when the brand has no logoFile", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({ qid: "Q1", name: "Q1", kind: ["brand"] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(addImage).not.toHaveBeenCalled();
  });

  it("resolves false without registering an image when the logo fetch is not ok", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      qid: "Q1",
      name: "Q1",
      kind: ["brand"],
      logoFile: "Aldi_logo.svg",
    });
    vi.stubGlobal(
      "fetch",
      // `blob` is a valid resolver here (not just `ok: false` with no body) so
      // this test actually exercises the `!response.ok` guard: without it,
      // the chain would carry on to a successful `Image.onload` (the default
      // `imageOutcome`) and call `addImage` anyway, and the assertion below
      // would catch that.
      vi.fn().mockResolvedValue({
        ok: false,
        blob: () => Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
      } as unknown as Response),
    );

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(false);
    expect(addImage).not.toHaveBeenCalled();
  });

  it("resolves false without registering an image when the rasterized logo fails to load", async () => {
    imageOutcome = "error";
    vi.spyOn(apiClient, "get").mockResolvedValue({
      qid: "Q1",
      name: "Q1",
      kind: ["brand"],
      logoFile: "Aldi_logo.svg",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
      } as unknown as Response),
    );

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(false);
    expect(addImage).not.toHaveBeenCalled();
  });

  it("registers the image and resolves true when the full chain succeeds", async () => {
    vi.spyOn(apiClient, "get").mockResolvedValue({
      qid: "Q1",
      name: "Q1",
      kind: ["brand"],
      logoFile: "Aldi_logo.svg",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(new Blob(["<svg/>"], { type: "image/svg+xml" })),
      } as unknown as Response),
    );

    const ok = await loadBrandMarkerImage(map, "Q1");

    expect(ok).toBe(true);
    expect(addImage).toHaveBeenCalledTimes(1);
    expect(addImage.mock.calls[0][0]).toBe(brandImageId("Q1"));
  });
});
