import { describe, expect, it } from "vitest";
import { integrationManifestSchema } from "../manifest";

const base = {
  id: "overlay-road-conditions",
  domains: ["map-overlay"],
};

function withOverlay(overlay: unknown) {
  return integrationManifestSchema.safeParse({
    ...base,
    frontend: { mapLayer: true, overlay },
  });
}

describe("declarative frontend.overlay spec", () => {
  it("preserves a full declarative overlay (source + layers + legend + popup)", () => {
    const r = withOverlay({
      source: { kind: "geojson-bbox", route: "/observations", bboxParam: "bbox" },
      layers: [
        {
          id: "points",
          type: "circle",
          interactive: true,
          paint: { "circle-color": ["get", "color"] },
        },
      ],
      legend: {
        kind: "categorical",
        items: [{ color: "#cc0033", label: "Critical" }],
      },
      popup: { titleField: "headline", rows: [{ field: "type", format: "text" }] },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const overlay = r.data.frontend?.overlay;
    expect(overlay?.source?.kind).toBe("geojson-bbox");
    expect(overlay?.source?.route).toBe("/observations");
    expect(overlay?.layers?.[0]?.type).toBe("circle");
    expect(overlay?.layers?.[0]?.interactive).toBe(true);
    expect(overlay?.legend?.kind).toBe("categorical");
    expect(overlay?.popup?.titleField).toBe("headline");
  });

  it("accepts a vector source with tiles", () => {
    const r = withOverlay({
      source: { kind: "vector", tiles: ["https://tiles.example/{z}/{x}/{y}.pbf"] },
      layers: [{ id: "roads", type: "line", sourceLayer: "road" }],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.overlay?.source?.tiles?.[0]).toContain("{z}");
  });

  it("rejects an unknown source.kind", () => {
    const r = withOverlay({
      source: { kind: "wms", route: "/observations" },
      layers: [{ id: "points", type: "circle" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects an unsupported layer type", () => {
    const r = withOverlay({
      source: { kind: "geojson-bbox", route: "/observations" },
      layers: [{ id: "x", type: "heatmap-3d" }],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a layer missing an id", () => {
    const r = withOverlay({
      source: { kind: "geojson-bbox", route: "/observations" },
      layers: [{ type: "circle" }],
    });
    expect(r.success).toBe(false);
  });

  it("preserves overlay images (id + path) the host registers for symbol-layer glyphs", () => {
    const r = withOverlay({
      source: { kind: "geojson-bbox", route: "/events" },
      images: [{ id: "rc-accident", path: "M1 21h22L12 2z" }],
      layers: [
        { id: "points", type: "circle" },
        {
          id: "icons",
          type: "symbol",
          layout: {
            "icon-image": ["match", ["get", "type"], "accident", "rc-accident", "rc-accident"],
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.overlay?.images?.[0]).toEqual({
      id: "rc-accident",
      path: "M1 21h22L12 2z",
    });
  });

  it("rejects an overlay image missing its path", () => {
    const r = withOverlay({
      source: { kind: "geojson-bbox", route: "/events" },
      images: [{ id: "rc-accident" }],
      layers: [{ id: "points", type: "circle" }],
    });
    expect(r.success).toBe(false);
  });

  it("still accepts the legacy minimal overlay (excludes + minZoom) and preserves it", () => {
    const r = withOverlay({ excludes: ["street-view"], minZoom: 5 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.overlay?.excludes).toEqual(["street-view"]);
    expect(r.data.frontend?.overlay?.minZoom).toBe(5);
  });
});
