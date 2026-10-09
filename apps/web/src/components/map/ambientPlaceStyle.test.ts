import { createRequire } from "node:module";
import type { SymbolLayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import { ambientPlaceStyle } from "./ambientPlaceStyle";

const require = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const { createExpression } = require("@maplibre/maplibre-gl-style-spec");

describe("ambient cartography with a hosted style", () => {
  it("adapts legacy sprite tokens to publication categories while keeping the provider's assets", () => {
    const native: SymbolLayerSpecification = {
      id: "hosted-poi-label",
      type: "symbol",
      source: "provider",
      "source-layer": "poi",
      layout: {
        "text-field": "{name}",
        "icon-image": "{class}_{subclass}",
        "text-font": ["Provider Sans"],
        "text-size": 13,
      },
      paint: { "text-color": "#806040", "text-halo-color": "#fafafa" },
    };
    const result = ambientPlaceStyle([native], false, false);
    expect(result.layout?.["text-font"]).toEqual(["Provider Sans"]);
    expect(result.paint).toEqual(native.paint);
    const expression = createExpression(
      result.layout?.["icon-image"],
      "layers.ambient.layout.icon-image",
    );
    expect(expression.result).toBe("success");
    expect(
      String(
        expression.value.evaluate(
          { zoom: 16 },
          { type: "Point", properties: { category: "station" } },
        ),
      ),
    ).toBe("railway_station");
    expect(JSON.stringify(result)).not.toContain("poi-railway");
  });
  it("keeps literals intact and uses a neutral label when no POI template exists", () => {
    const result = ambientPlaceStyle([], false, true);
    expect(result.layout?.["icon-image"]).toBeUndefined();
    expect(result.paint?.["text-color"]).toBe("#9aa0a6");
    expect(result.layout?.["icon-allow-overlap"]).toBe(false);
  });
});
