import type * as maplibregl from "maplibre-gl";

type TextField = unknown;

function isNameRead(node: unknown): boolean {
  return (
    Array.isArray(node) &&
    node.length === 2 &&
    node[0] === "get" &&
    typeof node[1] === "string" &&
    (node[1] === "name" || node[1].startsWith("name:") || node[1].startsWith("name_"))
  );
}

/**
 * Points every name a label reads at the map's language, falling back to the
 * supplied colon or underscore language properties, then plain `name`.
 * Only the name lookups change, so a label that also shows an
 * elevation, or names some features and not others, keeps doing that.
 * Running it again on its own output gives the same expression.
 */
export function localizeTextField(textField: TextField, locale: string): TextField {
  const languages = [...new Set([locale, locale.split("-")[0]])];
  const localized = [
    "coalesce",
    ...languages.flatMap((language) => [
      ["get", `name:${language}`],
      ["get", `name_${language}`],
    ]),
    ["get", "name"],
  ];
  if (typeof textField === "string") return textField.includes("{name") ? localized : textField;
  if (!Array.isArray(textField)) return textField;
  if (isNameRead(textField)) return localized;
  if (textField[0] === "coalesce" && textField.slice(1).every(isNameRead)) return localized;
  if (textField[0] === "literal") return textField;
  return textField.map((part) => localizeTextField(part, locale));
}

/**
 * Localize the labels of every symbol layer on the map. Unchanged labels are
 * skipped, so running it after each style mutation only touches layers that
 * were added since. It reads layout properties directly: serializing the
 * style for this would cost a full copy of every layer.
 */
export function localizeMapLabels(
  map: Pick<
    maplibregl.Map,
    "getLayersOrder" | "getLayer" | "getLayoutProperty" | "setLayoutProperty"
  >,
  locale: string,
): void {
  for (const id of map.getLayersOrder()) {
    if (map.getLayer(id)?.type !== "symbol") continue;
    const textField = map.getLayoutProperty(id, "text-field");
    if (!textField) continue;
    const localized = localizeTextField(textField, locale);
    if (JSON.stringify(localized) === JSON.stringify(textField)) continue;
    map.setLayoutProperty(
      id,
      "text-field",
      localized as maplibregl.DataDrivenPropertyValueSpecification<string>,
    );
  }
}
