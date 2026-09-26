export type ResultAttribute =
  | { kind: "cuisine"; value: string }
  | { kind: "outdoor_seating" }
  | { kind: "wheelchair_yes" | "wheelchair_designated" | "wheelchair_limited" };

const CUISINE_PLACEHOLDERS = new Set([
  "?",
  "fixme",
  "n/a",
  "na",
  "no",
  "none",
  "not_applicable",
  "null",
  "tbd",
  "todo",
  "undefined",
  "unknown",
  "yes",
]);

export function selectResultAttributes(
  tags: Record<string, string> | undefined,
): ResultAttribute[] {
  if (!tags) return [];
  const attributes: ResultAttribute[] = [];
  const cuisine = tags.cuisine
    ?.split(";")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part && !CUISINE_PLACEHOLDERS.has(part))
    .map((part) => part.replace(/_/g, " "));
  if (cuisine?.length) {
    const value = [...new Set(cuisine)].join(", ");
    attributes.push({ kind: "cuisine", value: value.charAt(0).toUpperCase() + value.slice(1) });
  }
  if (tags.outdoor_seating?.trim().toLowerCase() === "yes")
    attributes.push({ kind: "outdoor_seating" });
  const wheelchair = tags.wheelchair?.trim().toLowerCase();
  if (wheelchair === "yes" || wheelchair === "designated" || wheelchair === "limited") {
    attributes.push({ kind: `wheelchair_${wheelchair}` });
  }
  return attributes.slice(0, 2);
}
