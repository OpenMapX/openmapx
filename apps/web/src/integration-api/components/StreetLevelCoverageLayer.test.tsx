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
