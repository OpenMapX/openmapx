export { type ResolveOptions, resolveToken } from "./src/resolver";
export { sharedStrings, sharedT, token } from "./src/token";
export type { I18nToken, LocaleCatalog, LocaleStrings, Translatable } from "./src/types";

/**
 * Runtime check for whether a value is an `I18nToken`. Used by the client
 * resolver to decide between translating a token and rendering a passthrough
 * `string | number` value.
 */
export function isI18nToken(value: unknown): value is import("./src/types").I18nToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "$t" in value &&
    typeof (value as { $t: unknown }).$t === "string"
  );
}
