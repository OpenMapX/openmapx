// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  document.getElementById("openmapx-basemap-de-3d-renderer")?.remove();
  delete window.Mapbox3DTiles;
  vi.resetModules();
});

describe("basemap.de LoD2 renderer", () => {
  it("loads only the reviewed renderer bytes with CORS-enabled SRI", async () => {
    const { BASEMAP_LOD2_RENDERER_INTEGRITY, BASEMAP_LOD2_RENDERER_URL, loadBasemapLod2Renderer } =
      await import("../basemap-lod2");

    const pending = loadBasemapLod2Renderer();
    const script = document.getElementById("openmapx-basemap-de-3d-renderer") as HTMLScriptElement;

    expect(script.src).toBe(BASEMAP_LOD2_RENDERER_URL);
    expect(script.integrity).toBe(BASEMAP_LOD2_RENDERER_INTEGRITY);
    expect(script.crossOrigin).toBe("anonymous");

    class FakeDetailedLayer {
      id = "fake";
      type = "custom" as const;
      render = vi.fn();
    }
    window.Mapbox3DTiles = {
      Mapbox3DTilesLayer: FakeDetailedLayer as never,
    };
    script.dispatchEvent(new Event("load"));

    await expect(pending).resolves.toBe(window.Mapbox3DTiles);
  });

  it("fails closed and removes a renderer that does not pass browser loading checks", async () => {
    const { loadBasemapLod2Renderer } = await import("../basemap-lod2");
    const pending = loadBasemapLod2Renderer();
    const script = document.getElementById("openmapx-basemap-de-3d-renderer") as HTMLScriptElement;

    script.dispatchEvent(new Event("error"));

    await expect(pending).rejects.toThrow("integrity-pinned");
    expect(document.getElementById("openmapx-basemap-de-3d-renderer")).toBeNull();
  });

  it("removes an incompatible renderer so a later activation can retry", async () => {
    const { loadBasemapLod2Renderer } = await import("../basemap-lod2");
    const pending = loadBasemapLod2Renderer();
    const script = document.getElementById("openmapx-basemap-de-3d-renderer") as HTMLScriptElement;

    script.dispatchEvent(new Event("load"));

    await expect(pending).rejects.toThrow("without its layer constructor");
    expect(document.getElementById("openmapx-basemap-de-3d-renderer")).toBeNull();
  });
});
