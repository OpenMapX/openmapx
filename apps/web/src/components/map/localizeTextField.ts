import type * as maplibregl from "maplibre-gl";

type TextField = unknown;

export interface LocalizeTextFieldOptions {
  /** Stack the tile's non-Latin local name beneath the localized name when they differ. */
  bilingual?: boolean;
}

export interface LocalizeMapLabelsOptions {
  /** Enable bilingual local-script labels on eligible OpenMapTiles point layers. */
  showLocalScript?: boolean;
}

/**
 * OpenMapTiles point layers that carry a second line for non-Latin local scripts.
 * Macro regions (continents, oceans, countries, states), line-placed road/waterway
 * labels, mountain peaks, dense POIs and overlays stay single-language.
 */
export const BILINGUAL_LABEL_LAYER_IDS: ReadonlySet<string> = new Set([
  "place-other",
  "place-village",
  "place-town",
  "place-city-sm",
  "place-city-md",
  "place-city-lg",
  "place-city-capital",
  "poi-railway",
  "airport-label-major",
  "water-name-other",
]);

const BASEMAP_SOURCE_ID = "openmaptiles";

/**
 * Ordered tile property keys to check when picking a feature's primary label name.
 * `name:latin` precedes underscore `name_<lang>` keys because OpenMapTiles servers
 * pre-populate `name_de`/`name_en` with the raw local `name` when no translation
 * exists, which would otherwise mask the Latin transliteration. Underscore keys
 * stay in the chain for sources (such as ambient places) that only publish them.
 */
export function labelNameKeys(locale: string): string[] {
  const base = locale.split("-")[0] || locale;
  const colonLanguages = base !== locale ? [locale, base] : [locale];
  const keys = [
    ...colonLanguages.map((language) => `name:${language}`),
    "name:latin",
    `name_${base}`,
    "name",
  ];
  return [...new Set(keys)];
}

/** Resolve a feature's displayed primary name using the same fallback order as map labels. */
export function resolveLabelName(
  properties: Record<string, unknown> | null | undefined,
  locale?: string,
): string | null {
  if (!properties) return null;
  if (locale) {
    for (const key of labelNameKeys(locale)) {
      const value = properties[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
    return null;
  }
  const name = properties.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

function isNameRead(node: unknown): boolean {
  return (
    Array.isArray(node) &&
    node.length === 2 &&
    node[0] === "get" &&
    typeof node[1] === "string" &&
    (node[1] === "name" || node[1].startsWith("name:") || node[1].startsWith("name_"))
  );
}

const WHOLE_FIELD_NAME_TEMPLATE = /^\s*(?:\{name(?:[:_][^}]*)?\}\s*)+$/;

function isWholeFieldNameTemplate(textField: TextField): boolean {
  if (typeof textField === "string") return WHOLE_FIELD_NAME_TEMPLATE.test(textField);
  if (!Array.isArray(textField)) return false;
  if (isNameRead(textField)) return true;
  return textField[0] === "coalesce" && textField.slice(1).every(isNameRead);
}

function localizedNameExpression(locale: string): unknown[] {
  return ["coalesce", ...labelNameKeys(locale).map((key) => ["get", key])];
}

function bilingualNameExpression(locale: string): unknown[] {
  const primary = localizedNameExpression(locale);
  return [
    "let",
    "primary",
    ["coalesce", primary, ""],
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
  ];
}

function localizeNestedTextField(textField: TextField, localized: unknown[]): TextField {
  if (typeof textField === "string") {
    return WHOLE_FIELD_NAME_TEMPLATE.test(textField) ? localized : textField;
  }
  if (!Array.isArray(textField)) return textField;
  if (isNameRead(textField)) return localized;
  if (textField[0] === "coalesce" && textField.slice(1).every(isNameRead)) return localized;
  if (textField[0] === "literal") return textField;
  return textField.map((part) => localizeNestedTextField(part, localized));
}

/**
 * Points every name a label reads at the map's language, falling back through
 * `labelNameKeys(locale)`. When `bilingual` is enabled on a whole-field name
 * expression, stacks `name:nonlatin` underneath at 0.8 scale whenever it is
 * present and differs from the primary name. Compound expressions such as
 * `concat` stay single-language because MapLibre forbids nesting `format` inside
 * string operators.
 */
export function localizeTextField(
  textField: TextField,
  locale: string,
  options?: LocalizeTextFieldOptions,
): TextField {
  if (options?.bilingual && isWholeFieldNameTemplate(textField)) {
    return bilingualNameExpression(locale);
  }
  return localizeNestedTextField(textField, localizedNameExpression(locale));
}

interface RecordedLayerTemplate {
  original: TextField;
  originalJson: string;
  writtenJson: string;
}

type LocalizableMap = Pick<
  maplibregl.Map,
  "getLayersOrder" | "getLayer" | "getLayoutProperty" | "setLayoutProperty"
> &
  Partial<Pick<maplibregl.Map, "on">>;

const recordedOriginalsByMap = new WeakMap<object, Map<string, RecordedLayerTemplate>>();

function getRecordedOriginals(map: LocalizableMap): Map<string, RecordedLayerTemplate> {
  let recorded = recordedOriginalsByMap.get(map);
  if (!recorded) {
    recorded = new Map<string, RecordedLayerTemplate>();
    recordedOriginalsByMap.set(map, recorded);
    if (typeof map.on === "function") {
      const cache = recorded;
      map.on("styledataloading", () => {
        cache.clear();
      });
    }
  }
  return recorded;
}

function isBilingualLayer(
  layer: ReturnType<maplibregl.Map["getLayer"]>,
  id: string,
  showLocalScript: boolean,
): boolean {
  if (!showLocalScript || !BILINGUAL_LABEL_LAYER_IDS.has(id)) return false;
  const source = (layer as { source?: unknown } | undefined)?.source;
  return source === BASEMAP_SOURCE_ID;
}

/**
 * Localize the labels of every symbol layer on the map.
 *
 * Each layer's original `text-field` template is remembered per stylesheet and
 * cleared on `styledataloading`. Re-deriving from the recorded original makes
 * repeated `styledata` callbacks idempotent and lets locale and bilingual
 * switches reverse cleanly without reloading the style. If an overlay replaces
 * a layer under the same id with a different template, the new template becomes
 * the recorded original.
 */
export function localizeMapLabels(
  map: LocalizableMap,
  locale: string,
  options?: LocalizeMapLabelsOptions,
): void {
  const showLocalScript = options?.showLocalScript ?? false;
  const recorded = getRecordedOriginals(map);
  const layerIds = map.getLayersOrder();
  const liveIds = new Set(layerIds);

  for (const id of recorded.keys()) {
    if (!liveIds.has(id)) recorded.delete(id);
  }

  for (const id of layerIds) {
    const layer = map.getLayer(id);
    if (layer?.type !== "symbol") continue;
    const current = map.getLayoutProperty(id, "text-field");
    if (!current) continue;

    const currentJson = JSON.stringify(current);
    let record = recorded.get(id);
    if (!record || (currentJson !== record.writtenJson && currentJson !== record.originalJson)) {
      record = {
        original: current,
        originalJson: currentJson,
        writtenJson: currentJson,
      };
      recorded.set(id, record);
    }

    const localized = localizeTextField(record.original, locale, {
      bilingual: isBilingualLayer(layer, id, showLocalScript),
    });
    const localizedJson = JSON.stringify(localized);
    record.writtenJson = localizedJson;

    if (localizedJson === currentJson) continue;
    map.setLayoutProperty(
      id,
      "text-field",
      localized as maplibregl.DataDrivenPropertyValueSpecification<string>,
    );
  }
}
