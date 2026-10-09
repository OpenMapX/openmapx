import { createRequire } from "node:module";
import type { SymbolLayerSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";
import dark from "../../../public/styles/openmapx-dark.json";
import streets from "../../../public/styles/openmapx-streets.json";
import sprites from "../../../public/styles/sprite.json";
import { ambientPlaceStyle } from "./ambientPlaceStyle";

const require = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const { createExpression, latest } = require("@maplibre/maplibre-gl-style-spec");

describe.each([streets, dark])("ambient native POI badges in $name", (style) => {
  it.each([
    ["association", "poi-office"],
    ["company", "poi-office-company"],
    ["government", "poi-office-government"],
    ["hairdressers", "poi-hairdresser"],
    ["bars", "poi-bar"],
    ["dental_clinic", "poi-dentist"],
    ["fashion_and_apparel_store", "poi-clothing_store"],
    ["attorney_or_law_firm", "poi-office"],
    ["financial_service", "poi-office"],
    ["diagnostics_imaging_or_lab_service", "poi-doctors"],
    ["private_lodging", "poi-lodging"],
    ["unmapped_destination", "poi-multi"],
  ])("renders %s with the active style's POI badge", (category, expected) => {
    const result = ambientPlaceStyle(style.layers as SymbolLayerSpecification[], false, false);
    const expression = createExpression(
      result.layout?.["icon-image"],
      "icon-image",
      latest.layout_symbol["icon-image"],
    );
    expect(expression.result).toBe("success");
    expect(
      expression.value.evaluate(
        { zoom: 16 },
        { type: "Point", properties: { category } },
        undefined,
        undefined,
        Object.keys(sprites),
      ).name,
    ).toBe(expected);
  });

  it("uses standard native badge sizing and requires the landmark badge and label together", () => {
    const layers = style.layers as SymbolLayerSpecification[];
    const ordinary = ambientPlaceStyle(layers, false, false);
    const landmark = ambientPlaceStyle(layers, true, false);
    expect(landmark.layout?.["icon-size"]).toEqual(ordinary.layout?.["icon-size"]);
    expect(landmark.layout?.["icon-optional"]).toBe(false);
    expect(landmark.layout?.["text-optional"]).toBe(false);
    expect(landmark.layout?.["icon-allow-overlap"]).toBe(false);
    expect(landmark.layout?.["text-allow-overlap"]).toBe(false);
  });
});

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
