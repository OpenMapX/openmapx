import type { StreetLevelCapabilities } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  coverageLayerIds,
  coverageSourceId,
  pictureLayerIds,
  providerIdByLayer,
} from "./StreetLevelCoverageLayer";

const capability = (id: string): StreetLevelCapabilities => ({
  id,
  name: id,
  color: "#000",
  endUserExposure: "direct",
  allowsNavigationUse: true,
  search: { heading: false, capturedAfter: true, lookingAt: false },
  coverage: {
    kind: "mvt",
    tileUrlTemplate: `/api/integrations/street-level-imagery-${id}/tiles/{z}/{x}/{y}`,
    minzoom: 0,
    maxzoom: 15,
    layers: { sequences: "sequences", pictures: "pictures" },
    props: { id: "id" },
  },
});

describe("coverage layer identifiers", () => {
  it("namespaces the source per provider", () => {
    expect(coverageSourceId("panoramax")).toBe("sli-panoramax");
    expect(coverageSourceId("mapillary")).toBe("sli-mapillary");
  });

  it("derives all four layer ids per provider", () => {
    expect(coverageLayerIds("panoramax")).toEqual({
      sequences: "sli-panoramax-sequences",
      pictures: "sli-panoramax-pictures",
      picturesPano: "sli-panoramax-pictures-pano",
      grid: "sli-panoramax-grid",
    });
  });

  it("never collides between providers", () => {
    const a = Object.values(coverageLayerIds("panoramax"));
    const b = Object.values(coverageLayerIds("mapillary"));
    expect(a.filter((id) => b.includes(id))).toEqual([]);
  });
});

describe("pictureLayerIds", () => {
  it("returns both picture layers for every provider, in order", () => {
    expect(pictureLayerIds([capability("panoramax"), capability("mapillary")])).toEqual([
      "sli-panoramax-pictures",
      "sli-panoramax-pictures-pano",
      "sli-mapillary-pictures",
      "sli-mapillary-pictures-pano",
    ]);
  });

  it("returns nothing when no providers are enabled", () => {
    expect(pictureLayerIds([])).toEqual([]);
  });
});

describe("providerIdByLayer", () => {
  it("maps each clickable layer back to its owning provider", () => {
    const byLayer = providerIdByLayer([capability("panoramax"), capability("mapillary")]);
    expect(byLayer.get("sli-panoramax-pictures")).toBe("panoramax");
    expect(byLayer.get("sli-mapillary-pictures-pano")).toBe("mapillary");
    expect(byLayer.get("sli-unknown-pictures")).toBeUndefined();
  });
});

let currentProviders: StreetLevelCapabilities[] = [];
let fake: import("@/test").FakeMap;
const ref = {
  get current() {
    return fake.map;
  },
};
vi.mock("./useStreetLevelProviders", () => ({
  useStreetLevelProviders: () => ({ providers: currentProviders }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: ref, mapReady: true, styleVersion: 0 }),
}));
vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

import { useStreetLevelStore } from "@openmapx/core";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { afterEach, beforeEach, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { act, createFakeMap, render } from "@/test";
import { StreetLevelCoverageLayer } from "./StreetLevelCoverageLayer";

function fixture(id: string, minzoom = 0): StreetLevelCapabilities {
  const p = capability(id);
  return {
    ...p,
    coverage: {
      ...p.coverage,
      minzoom,
      layerContributors: {
        sequences: [{ sourceId: id, name: id, attributionText: `Original ${id} notice` }],
        pictures: [{ sourceId: id, name: id, attributionText: `Original ${id} notice` }],
        grid: [{ sourceId: id, name: id, attributionText: `Original ${id} notice` }],
      },
    },
  } as StreetLevelCapabilities;
}
function hit(): MapGeoJSONFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: { coef: 1 },
  } as unknown as MapGeoJSONFeature;
}
function flush() {
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
}
function html() {
  return Object.values(useMapAttributionStore.getState().byLayer)
    .flat()
    .map((entry) => entry.fullHtml)
    .join(" ");
}
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeMap({ zoom: 4 });
  currentProviders = [fixture("mapillary", 6), fixture("panoramax")];
  const p = currentProviders[1];
  if (!p) throw new Error("Missing Panoramax fixture");
  if (p.coverage.kind === "mvt") p.coverage.layers.grid = "grid";
  useMapAttributionStore.setState({ byLayer: {} });
  useStreetLevelStore.setState({ layerVisible: true });
});
afterEach(() => {
  act(() => useStreetLevelStore.setState({ layerVisible: false }));
  vi.useRealTimers();
});
describe("provider-specific rendered coverage receipts", () => {
  it("credits Panoramax lowzoom grid but excludes below-minimum Mapillary", () => {
    render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    fake.setRenderedFeatures("sli-mapillary-sequences", [hit()]);
    flush();
    expect(html()).toContain("Original panoramax notice");
    expect(html()).not.toContain("mapillary");
  });
  it("credits no provider when coverage is empty or offscreen", () => {
    render(<StreetLevelCoverageLayer />);
    flush();
    expect(html()).toBe("");
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    flush();
    expect(html()).toContain("panoramax");
    fake.setRenderedFeatures("sli-panoramax-grid", []);
    flush();
    expect(html()).toBe("");
  });
  it("retains the source generation's original notice overzoom and metadata refresh", () => {
    fake.state.zoom = 18;
    const { rerender } = render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-mapillary-sequences", [hit()]);
    flush();
    expect(html()).toContain("Original mapillary notice");
    currentProviders = [fixture("replacement", 6)].map((p) => ({
      ...p,
      id: "mapillary",
      coverage: {
        ...p.coverage,
        tileUrlTemplate: capability("mapillary").coverage.tileUrlTemplate,
      },
    }));
    rerender(<StreetLevelCoverageLayer />);
    flush();
    expect(html()).toContain("Original mapillary notice");
    expect(html()).not.toContain("replacement");
  });
  it("an authoritative empty layer receipt does not borrow another provider", () => {
    const p = currentProviders[1];
    if (!p) throw new Error("Missing Panoramax fixture");
    (
      p.coverage as typeof p.coverage & { layerContributors: Record<string, unknown[]> }
    ).layerContributors.grid = [];
    render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    flush();
    expect(html()).toBe("");
  });
  it("keeps native feature [] authoritative over a uniform provider certificate", () => {
    render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-panoramax-grid", [
      { ...hit(), properties: { coef: 1, _mapAttributions: "[]" } } as unknown as MapGeoJSONFeature,
    ]);
    flush();
    expect(html()).toBe("");
  });
  it("removes a filtered hidden layer and an excluded provider independently", () => {
    fake.state.zoom = 12;
    const { rerender } = render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-mapillary-sequences", [hit()]);
    fake.setRenderedFeatures("sli-panoramax-sequences", [hit()]);
    flush();
    expect(html()).toContain("mapillary");
    expect(html()).toContain("panoramax");
    fake.map.setLayoutProperty("sli-mapillary-sequences", "visibility", "none");
    flush();
    expect(html()).not.toContain("mapillary");
    expect(html()).toContain("panoramax");
    currentProviders = [fixture("mapillary", 6)];
    rerender(<StreetLevelCoverageLayer />);
    flush();
    expect(html()).toBe("");
    expect(fake.state.sources.has("sli-panoramax")).toBe(false);
  });
  it("replays retained provider source receipts over style reload and reinitializes a replacement map", async () => {
    const { rerender } = render(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    flush();
    act(() => fake.map.setStyle({} as never));
    await act(async () => {});
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    flush();
    expect(html()).toContain("Original panoramax notice");
    const oldMap = fake;
    fake = createFakeMap({ zoom: 4 });
    rerender(<StreetLevelCoverageLayer />);
    fake.setRenderedFeatures("sli-panoramax-grid", [hit()]);
    flush();
    expect(html()).toContain("Original panoramax notice");
    expect(oldMap.state.layers.has("sli-panoramax-grid")).toBe(false);
  });
});
