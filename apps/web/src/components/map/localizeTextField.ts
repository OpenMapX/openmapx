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
