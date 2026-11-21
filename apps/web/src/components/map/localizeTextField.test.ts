import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { type StyleSpecification, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { buildScriptFontFaces } from "@/lib/scriptFontFaces";
import { createFakeMap } from "@/test";
import {
  BILINGUAL_LABEL_LAYER_IDS,
  labelNameKeys,
  localizeMapLabels,
  localizeTextField,
  resolveLabelName,
} from "./localizeTextField";

const requireFromMapLibre = createRequire(import.meta.resolve("maplibre-gl/package.json"));
const { createExpression, latest } = requireFromMapLibre("@maplibre/maplibre-gl-style-spec") as {
  createExpression: (
    expr: unknown,
    spec: unknown,
  ) => {
    result: "success" | "error";
    value: {
      evaluate: (
        globals: { zoom: number },
        feature: { type: string; properties: Record<string, unknown> },
      ) => { sections: Array<{ text: string; scale: number | null }> };
    };
  };
  latest: { layout_symbol: { "text-field": unknown } };
};

const GERMAN = [
  "coalesce",
  ["get", "name:de"],
  ["get", "name:latin"],
  ["get", "name_de"],
  ["get", "name"],
];

const ENGLISH = [
  "coalesce",
  ["get", "name:en"],
  ["get", "name:latin"],
  ["get", "name_en"],
  ["get", "name"],
];

const STYLES_DIR = join(import.meta.dirname, "../../../public/styles");

describe("labelNameKeys and resolveLabelName", () => {
  it("puts name:latin ahead of underscore fallbacks and deduplicates base locales", () => {
    expect(labelNameKeys("de")).toEqual(["name:de", "name:latin", "name_de", "name"]);
    expect(labelNameKeys("de-AT")).toEqual([
      "name:de-AT",
      "name:de",
      "name:latin",
      "name_de",
      "name",
    ]);
  });

  it("picks Latin transliteration over server-filled non-Latin underscore fallbacks", () => {
    // OpenMapTiles fills `name_de` with the raw local `name` when `name:de` is absent.
    const ruralJapan = {
      name: "琴浦町",
      "name:latin": "Kotoura",
      "name:nonlatin": "琴浦町",
      name_de: "琴浦町",
      name_en: "Kotoura",
    };
    expect(resolveLabelName(ruralJapan, "de")).toBe("Kotoura");
    expect(resolveLabelName(ruralJapan, "de-AT")).toBe("Kotoura");

    // Sources such as ambient_places publish underscore keys without `name:latin`.
    const ambientPlace = { name: "Kölner Dom", name_en: "Cologne Cathedral" };
    expect(resolveLabelName(ambientPlace, "en")).toBe("Cologne Cathedral");

    // Explicit localized tags always win over `name:latin`.
    const athens = {
      name: "Αθήνα",
      "name:de": "Athen",
      "name:latin": "Athens",
      name_de: "Athen",
    };
    expect(resolveLabelName(athens, "de")).toBe("Athen");
    expect(resolveLabelName(athens, "en")).toBe("Athens");
    expect(resolveLabelName(athens)).toBe("Αθήνα");
  });
});

describe("localizeTextField", () => {
  it("turns a legacy name token into the localized name", () => {
    expect(localizeTextField("{name:latin}\n{name:nonlatin}", "de")).toEqual(GERMAN);
    expect(localizeTextField(["coalesce", ["get", "name:latin"], ["get", "name"]], "de")).toEqual(
      GERMAN,
    );
  });

  it("changes only the name inside a larger label, even when bilingual is requested", () => {
    const peak = [
      "concat",
      ["get", "name"],
      ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
    ];
    expect(localizeTextField(peak, "de", { bilingual: true })).toEqual([
      "concat",
      GERMAN,
      ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
    ]);

    const stopsUnnamed = ["case", ["==", ["get", "class"], "bus"], "", ["get", "name"]];
    expect(localizeTextField(stopsUnnamed, "de", { bilingual: true })).toEqual([
      "case",
      ["==", ["get", "class"], "bus"],
      "",
      GERMAN,
    ]);
  });

  it("builds a bilingual format expression for whole-field templates", () => {
    const expr = localizeTextField("{name:latin}\n{name:nonlatin}", "de", { bilingual: true });
    expect(expr).toEqual([
      "let",
      "primary",
      ["coalesce", GERMAN, ""],
      "secondary",
      ["coalesce", ["get", "name:nonlatin"], ""],
      [
        "case",
        ["==", ["var", "primary"], ""],
        ["format", ["var", "secondary"], {}],
        ["any", ["==", ["var", "secondary"], ""], ["==", ["var", "primary"], ["var", "secondary"]]],
        ["format", ["var", "primary"], {}],
        ["format", ["var", "primary"], {}, "\n", {}, ["var", "secondary"], { "font-scale": 0.8 }],
      ],
    ]);
  });

  it("evaluates the bilingual expression across stacked, single-line, fallback, and empty features", () => {
    const evaluateBilingual = (locale: string, properties: Record<string, unknown>) => {
      const expr = localizeTextField("{name:latin}\n{name:nonlatin}", locale, { bilingual: true });
      const parsed = createExpression(expr, latest.layout_symbol["text-field"]);
      expect(parsed.result).toBe("success");
      return parsed.value
        .evaluate({ zoom: 10 }, { type: "Point", properties })
        .sections.map((section) => ({ text: section.text, scale: section.scale }));
    };

    // Tokyo in German: translated name stacked above local kanji at 0.8 scale.
    expect(
      evaluateBilingual("de", {
        name: "東京都",
        "name:de": "Tokio",
        "name:latin": "Tokyo",
        "name:nonlatin": "東京都",
      }),
    ).toEqual([
      { text: "Tokio", scale: null },
      { text: "\n", scale: null },
      { text: "東京都", scale: 0.8 },
    ]);

    // Moscow in Russian: primary equals name:nonlatin -> single section, no duplicate line.
    expect(
      evaluateBilingual("ru", {
        name: "Москва",
        "name:ru": "Москва",
        "name:latin": "Moscow",
        "name:nonlatin": "Москва",
      }),
    ).toEqual([{ text: "Москва", scale: null }]);

    // Berlin: no name:nonlatin -> single section.
    expect(
      evaluateBilingual("de", {
        name: "Berlin",
        "name:de": "Berlin",
        "name:latin": "Berlin",
      }),
    ).toEqual([{ text: "Berlin", scale: null }]);

    // Only name:nonlatin present -> secondary alone without a leading newline.
    expect(evaluateBilingual("de", { "name:nonlatin": "東京" })).toEqual([
      { text: "東京", scale: null },
    ]);

    // Rural Japan in German: primary falls back to name:latin over server-filled name_de, stacked with kanji.
    expect(
      evaluateBilingual("de", {
        name: "琴浦町",
        "name:latin": "Kotoura",
        "name:nonlatin": "琴浦町",
        name_de: "琴浦町",
      }),
    ).toEqual([
      { text: "Kotoura", scale: null },
      { text: "\n", scale: null },
      { text: "琴浦町", scale: 0.8 },
    ]);

    // No name properties at all -> empty single section.
    expect(evaluateBilingual("de", {})).toEqual([{ text: "", scale: null }]);
  });

  it("leaves labels that show no name or mix extra tokens in legacy strings alone", () => {
    expect(localizeTextField(["get", "housenumber"], "de")).toEqual(["get", "housenumber"]);
    expect(localizeTextField("{ref}", "de")).toBe("{ref}");
    expect(localizeTextField("{name}\n{ele} m", "de", { bilingual: true })).toBe("{name}\n{ele} m");
    const literal = ["match", ["get", "class"], ["literal", ["name"]], "x", "y"];
    expect(localizeTextField(literal, "de")).toEqual(literal);
  });
});

describe("localizeMapLabels", () => {
  it("derives from recorded originals so repeated passes are no-ops and mode switches reverse cleanly", () => {
    const fake = createFakeMap({
      baseLayers: [
        {
          id: "place-city-capital",
          type: "symbol",
          source: "openmaptiles",
          layout: { "text-field": "{name:latin}\n{name:nonlatin}" },
        },
        {
          id: "highway-name-major",
          type: "symbol",
          source: "openmaptiles",
          layout: { "text-field": "{name:latin} {name:nonlatin}" },
        },
        {
          id: "ambient-places-labels",
          type: "symbol",
          source: "ambient-places-source",
          layout: { "text-field": ["coalesce", ["get", "name_de"], ["get", "name"]] },
        },
        {
          id: "road-shield",
          type: "symbol",
          source: "openmaptiles",
          layout: { "text-field": "{ref}" },
        },
        { id: "water", type: "fill", source: "openmaptiles" },
      ],
    });

    localizeMapLabels(fake.map, "de", { showLocalScript: true });
    const bilingualCity = fake.map.getLayoutProperty("place-city-capital", "text-field");
    expect(bilingualCity).toEqual(
      localizeTextField("{name:latin}\n{name:nonlatin}", "de", { bilingual: true }),
    );
    // Line layers and non-basemap overlays stay single-language.
    expect(fake.map.getLayoutProperty("highway-name-major", "text-field")).toEqual(GERMAN);
    expect(fake.map.getLayoutProperty("ambient-places-labels", "text-field")).toEqual(GERMAN);
    expect(fake.map.getLayoutProperty("road-shield", "text-field")).toBe("{ref}");

    // Second pass (e.g. triggered by styledata) is a no-op and does not corrupt the expression.
    const snapshot = fake.state.layout.get("place-city-capital");
    localizeMapLabels(fake.map, "de", { showLocalScript: true });
    expect(fake.state.layout.get("place-city-capital")).toBe(snapshot);
    expect(fake.map.getLayoutProperty("place-city-capital", "text-field")).toEqual(bilingualCity);

    // Turning off local scripts or switching locale re-derives cleanly from the recorded original.
    localizeMapLabels(fake.map, "en", { showLocalScript: false });
    expect(fake.map.getLayoutProperty("place-city-capital", "text-field")).toEqual(ENGLISH);
    expect(fake.map.getLayoutProperty("ambient-places-labels", "text-field")).toEqual(ENGLISH);

    localizeMapLabels(fake.map, "en", { showLocalScript: true });
    expect(fake.map.getLayoutProperty("place-city-capital", "text-field")).toEqual(
      localizeTextField("{name:latin}\n{name:nonlatin}", "en", { bilingual: true }),
    );
  });

  it("resets recorded originals on styledataloading and adopts replaced overlay templates", () => {
    const fake = createFakeMap({
      baseLayers: [
        {
          id: "place-city-lg",
          type: "symbol",
          source: "openmaptiles",
          layout: { "text-field": "{name:latin}\n{name:nonlatin}" },
        },
      ],
    });

    localizeMapLabels(fake.map, "de", { showLocalScript: true });
    expect(fake.map.getLayoutProperty("place-city-lg", "text-field")).toEqual(
      localizeTextField("{name:latin}\n{name:nonlatin}", "de", { bilingual: true }),
    );

    // Simulate a light -> dark style swap where the layer returns with a new template.
    fake.emit("styledataloading");
    fake.map.setLayoutProperty("place-city-lg", "text-field", "{ref}");
    localizeMapLabels(fake.map, "de", { showLocalScript: true });
    expect(fake.map.getLayoutProperty("place-city-lg", "text-field")).toBe("{ref}");

    // Simulate an overlay replacing a layer under the same id without a full style swap.
    fake.map.addLayer({
      id: "overlay-label",
      type: "symbol",
      source: "custom-overlay",
      layout: { "text-field": ["get", "name"] },
    } as never);
    localizeMapLabels(fake.map, "de", { showLocalScript: true });
    expect(fake.map.getLayoutProperty("overlay-label", "text-field")).toEqual(GERMAN);

    fake.map.removeLayer("overlay-label");
    fake.map.addLayer({
      id: "overlay-label",
      type: "symbol",
      source: "custom-overlay",
      layout: { "text-field": ["concat", ["get", "name"], " km"] },
    } as never);
    localizeMapLabels(fake.map, "en", { showLocalScript: true });
    expect(fake.map.getLayoutProperty("overlay-label", "text-field")).toEqual([
      "concat",
      ENGLISH,
      " km",
    ]);
  });

  it.each(["openmapx-streets.json", "openmapx-dark.json"] as const)(
    "produces a MapLibre-valid %s stylesheet in single-language and bilingual modes",
    (filename) => {
      const raw = JSON.parse(
        readFileSync(join(STYLES_DIR, filename), "utf8"),
      ) as StyleSpecification;
      const baseStyle: StyleSpecification = {
        ...raw,
        sources: {
          ...raw.sources,
          openmaptiles: {
            type: "vector",
            url: "https://tiles.openfreemap.org/planet",
          },
        },
        sprite: "https://maps.example/styles/sprite",
        glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
        "font-faces": buildScriptFontFaces("https://maps.example"),
      };

      for (const showLocalScript of [false, true]) {
        const fake = createFakeMap({
          baseLayers: baseStyle.layers.map((layer) => ({
            id: layer.id,
            type: layer.type,
            source: "source" in layer ? (layer.source as string) : undefined,
            layout: "layout" in layer ? (layer.layout as Record<string, unknown>) : undefined,
          })),
        });
        localizeMapLabels(fake.map, "de", { showLocalScript });

        const localizedStyle: StyleSpecification = {
          ...baseStyle,
          layers: baseStyle.layers.map((layer) => {
            if (layer.type !== "symbol") return layer;
            const nextField = fake.map.getLayoutProperty(layer.id, "text-field");
            if (!nextField) return layer;
            return {
              ...layer,
              layout: {
                ...(layer.layout ?? {}),
                "text-field": nextField,
              },
            } as StyleSpecification["layers"][number];
          }),
        };

        const errors = validateStyleMin(localizedStyle);
        expect(errors, `${filename} (showLocalScript=${showLocalScript})`).toEqual([]);

        if (showLocalScript) {
          for (const id of BILINGUAL_LABEL_LAYER_IDS) {
            const field = fake.map.getLayoutProperty(id, "text-field");
            expect(Array.isArray(field) && field[0] === "let", `${id} should be bilingual`).toBe(
              true,
            );
          }
          expect(fake.map.getLayoutProperty("highway-name-major", "text-field")).toEqual(GERMAN);
          expect(fake.map.getLayoutProperty("place-country-1", "text-field")).toEqual(GERMAN);
          expect(fake.map.getLayoutProperty("mountain-peak", "text-field")).toEqual([
            "concat",
            GERMAN,
            ["case", ["has", "ele"], ["concat", "\n", ["to-string", ["get", "ele"]], " m"], ""],
          ]);
        }
      }
    },
  );
});
