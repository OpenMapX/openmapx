// A DOM helper, not a component: the .tsx extension is what routes this file
// into the root config's jsdom project for `integrations/**`.
import { describe, expect, it, vi } from "vitest";
import { exportTransitIsochrone, transitIsochroneFilename } from "../export-geojson";

const COLLECTION: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

describe("transitIsochroneFilename", () => {
  it("encodes the departure instant without characters that break filesystems", () => {
    const name = transitIsochroneFilename("2026-09-01T08:00:00.000Z");
    expect(name).toMatch(/^transit-isochrone-[\w-]+\.geojson$/);
    expect(name).not.toContain(":");
  });
});

describe("exportTransitIsochrone", () => {
  it("downloads a blob under the given name and releases the object URL", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    exportTransitIsochrone(COLLECTION, "transit-isochrone-test.geojson");

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    // The anchor must not be left behind in the document.
    expect(document.querySelector("a[download]")).toBeNull();

    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it("serialises the provenance member so the saved file stays self-describing", async () => {
    const captured: Blob[] = [];
    const createObjectURL = vi.fn((blob: unknown) => {
      captured.push(blob as Blob);
      return "blob:mock";
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const withMeta = {
      ...COLLECTION,
      openmapx: { accuracy: "sampled", method: "motis-one-to-many-grid" },
    } as unknown as GeoJSON.FeatureCollection;
    exportTransitIsochrone(withMeta, "x.geojson");

    expect(captured).toHaveLength(1);
    expect(captured[0].type).toBe("application/geo+json");
    const parsed = JSON.parse(await captured[0].text());
    expect(parsed.openmapx.accuracy).toBe("sampled");

    click.mockRestore();
    vi.unstubAllGlobals();
  });
});
