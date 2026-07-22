import { describe, expect, it } from "vitest";
import { dedupeSharedMapLayers } from "./sharedIntegrationLayer";

const integration = (id: string, sharedMapLayer?: string) => ({
  id,
  frontend: sharedMapLayer ? { sharedMapLayer } : {},
});

describe("dedupeSharedMapLayers", () => {
  it("keeps every integration that declares no shared layer", () => {
    const list = [integration("overlay-traffic-tomtom"), integration("overlay-wildfires")];
    expect(dedupeSharedMapLayers(list).map((i) => i.id)).toEqual([
      "overlay-traffic-tomtom",
      "overlay-wildfires",
    ]);
  });

  it("keeps only the first integration of a shared-layer group", () => {
    const list = [
      integration("street-level-imagery-panoramax", "street-level-imagery"),
      integration("street-level-imagery-mapillary", "street-level-imagery"),
    ];
    expect(dedupeSharedMapLayers(list).map((i) => i.id)).toEqual([
      "street-level-imagery-panoramax",
    ]);
  });

  it("treats different shared-layer keys as independent groups", () => {
    const list = [
      integration("street-level-imagery-panoramax", "street-level-imagery"),
      integration("street-level-imagery-mapillary", "street-level-imagery"),
      integration("thing-a", "other"),
    ];
    expect(dedupeSharedMapLayers(list).map((i) => i.id)).toEqual([
      "street-level-imagery-panoramax",
      "thing-a",
    ]);
  });

  it("preserves registry order", () => {
    const list = [
      integration("street-level-imagery-mapillary", "street-level-imagery"),
      integration("street-level-imagery-panoramax", "street-level-imagery"),
    ];
    expect(dedupeSharedMapLayers(list).map((i) => i.id)).toEqual([
      "street-level-imagery-mapillary",
    ]);
  });
});
