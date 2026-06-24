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

describe("frontend.overlay spec (lightweight config; markers/popups live in code)", () => {
  it("preserves excludes, minZoom and a declarative legend", () => {
    const r = withOverlay({
      excludes: ["street-view", "earthquakes"],
      minZoom: 5,
      legend: {
        kind: "categorical",
        title: "Road conditions",
        items: [{ color: "#cc0033", label: "High" }],
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const overlay = r.data.frontend?.overlay;
    expect(overlay?.excludes).toEqual(["street-view", "earthquakes"]);
    expect(overlay?.minZoom).toBe(5);
    expect(overlay?.legend?.kind).toBe("categorical");
    expect(overlay?.legend?.items?.[0]?.color).toBe("#cc0033");
  });

  it("accepts a ramp legend with stops", () => {
    const r = withOverlay({
      legend: {
        kind: "ramp",
        stops: [
          { value: 0, color: "#fff" },
          { value: 100, color: "#000" },
        ],
      },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.overlay?.legend?.stops?.length).toBe(2);
  });

  it("drops removed declarative marker/popup fields rather than rejecting them", () => {
    // source/images/layers/popup moved to code (map-layer.tsx). A manifest that
    // still carries them parses, but the host-irrelevant fields are stripped.
    const r = withOverlay({
      minZoom: 5,
      source: { kind: "geojson-bbox", route: "/events" },
      images: [{ id: "x", path: "M0 0" }],
      layers: [{ id: "points", type: "circle" }],
      popup: { titleField: "headline" },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const overlay = r.data.frontend?.overlay as Record<string, unknown> | undefined;
    expect(overlay?.minZoom).toBe(5);
    expect(overlay?.source).toBeUndefined();
    expect(overlay?.images).toBeUndefined();
    expect(overlay?.layers).toBeUndefined();
    expect(overlay?.popup).toBeUndefined();
  });

  it("still accepts the minimal overlay (excludes only)", () => {
    const r = withOverlay({ excludes: ["street-view"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.frontend?.overlay?.excludes).toEqual(["street-view"]);
  });
});
