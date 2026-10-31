/** Pure credential data validation. These values confer no authority; callers
 * must separately check catalog membership, ownership, proofs and revisions. */
export type FeedCredentialChange =
  | { key: string; action: "set"; value: string }
  | { key: string; action: "delete" };
export type ValidatedFeedCredentialMap = {
  values: Readonly<Record<string, string>>;
  canonicalJson: string;
  utf8Bytes: number;
  entryCount: number;
};
function utf8BytesOf(value: string) {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
// With Unicode regex semantics a valid surrogate pair is one astral code point;
// only lone surrogate code units match this range. Works with the package's ES target.
export const isWellFormedFeedCredentialText = (value: string) => !/[\uD800-\uDFFF]/u.test(value);
const invalid = () => new Error("Feed credential map is invalid");
const budget = () => new Error("Feed credential map exceeds its budget");
const unsafe = new Set(["__proto__", "constructor", "prototype"]);
function keyIsValid(key: string) {
  return (
    isWellFormedFeedCredentialText(key) &&
    key.length > 0 &&
    [...key].length <= 512 &&
    !unsafe.has(key)
  );
}
function entriesOf(value: unknown): [string, string][] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw invalid();
  return Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
    if (
      !keyIsValid(key) ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "string" ||
      !isWellFormedFeedCredentialText(descriptor.value)
    )
      throw invalid();
    return [key, descriptor.value];
  });
}
export function canonicalFeedCredentialMap(
  values: Readonly<Record<string, string>>,
): ValidatedFeedCredentialMap {
  const entries = entriesOf(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length > 1000 || entries.some(([, value]) => utf8BytesOf(value) > 8192))
    throw budget();
  // JSON.stringify(object) reorders integer-looking keys numerically; serialize
  // the sorted entries explicitly so every key uses the same code-unit order.
  const canonicalJson = `{${entries.map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`).join(",")}}`;
  const utf8Bytes = utf8BytesOf(canonicalJson);
  if (utf8Bytes > 65536) throw budget();
  return {
    values: Object.freeze(Object.fromEntries(entries)),
    canonicalJson,
    utf8Bytes,
    entryCount: entries.length,
  };
}
export function parseFeedCredentialMapJson(json: string): Readonly<Record<string, string>> {
  // A bounded legacy aggregate may be read for explicit correction; final-map
  // limits are enforced after merging, including every unchanged/orphaned key.
  if (
    typeof json !== "string" ||
    !isWellFormedFeedCredentialText(json) ||
    utf8BytesOf(json) > 1048576
  )
    throw invalid();
  let cursor = 0;
  const whitespace = () => {
    while (cursor < json.length && /[\t\r\n ]/.test(json[cursor] ?? "")) cursor++;
  };
  const string = (): string => {
    const start = cursor;
    if (json[cursor++] !== '"') throw invalid();
    let escaped = false;
    while (cursor < json.length) {
      const char = json[cursor++];
      if (char === '"' && !escaped) {
        try {
          const value: unknown = JSON.parse(json.slice(start, cursor));
          if (typeof value !== "string" || !isWellFormedFeedCredentialText(value)) throw invalid();
          return value;
        } catch {
          throw invalid();
        }
      }
      escaped = char === "\\" && !escaped;
    }
    throw invalid();
  };
  const retained = new Map<string, string>();
  whitespace();
  if (json[cursor++] !== "{") throw invalid();
  whitespace();
  if (json[cursor] !== "}") {
    for (;;) {
      const key = string();
      if (!keyIsValid(key) || retained.has(key)) throw invalid();
      whitespace();
      if (json[cursor++] !== ":") throw invalid();
      whitespace();
      const value = string();
      retained.set(key, value);
      whitespace();
      if (json[cursor] !== ",") break;
      cursor++;
      whitespace();
    }
  }
  if (json[cursor++] !== "}") throw invalid();
  whitespace();
  if (cursor !== json.length) throw invalid();
  return Object.freeze(Object.fromEntries(retained));
}
export function validateFeedCredentialMap(
  existing: Readonly<Record<string, string>>,
  changes: readonly FeedCredentialChange[],
  maxChanges: 100 | 1000 = 100,
): ValidatedFeedCredentialMap {
  const values = Object.fromEntries(entriesOf(existing));
  if (!Array.isArray(changes) || changes.length > maxChanges) throw invalid();
  const seen = new Set<string>();
  for (const change of changes) {
    if (
      !change ||
      typeof change !== "object" ||
      typeof change.key !== "string" ||
      !keyIsValid(change.key) ||
      seen.has(change.key)
    )
      throw invalid();
    seen.add(change.key);
    if (change.action === "set") {
      if (
        Object.keys(change).some((key) => !["key", "action", "value"].includes(key)) ||
        typeof change.value !== "string" ||
        !isWellFormedFeedCredentialText(change.value)
      )
        throw invalid();
      values[change.key] = change.value;
    } else if (change.action === "delete") {
      if (Object.keys(change).some((key) => !["key", "action"].includes(key))) throw invalid();
      delete values[change.key];
    } else throw invalid();
  }
  return canonicalFeedCredentialMap(values);
}
export function mergeFeedCredentialTemplate(
  existing: Readonly<Record<string, string>>,
  required: readonly string[],
) {
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string" || !keyIsValid(key))
  )
    throw invalid();
  const values = Object.fromEntries(entriesOf(existing)),
    keys = [...new Set(required)].sort(),
    requiredKeys = new Set(keys);
  const orphanedKeys = Object.keys(values)
    .filter((key) => !requiredKeys.has(key))
    .sort();
  const preservedCount = Object.keys(values).length;
  for (const key of keys) if (!Object.hasOwn(values, key)) values[key] = "";
  const validated = canonicalFeedCredentialMap(values);
  return {
    values: validated.values,
    requiredCount: keys.length,
    preservedCount,
    orphanedKeys,
    droppedCount: 0 as const,
  };
}
