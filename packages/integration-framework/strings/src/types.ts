/**
 * A locale-agnostic translation token emitted by data-source providers across
 * the API boundary. Resolved client-side via `resolveToken` against the
 * emitting integration's strings catalog (with framework shared strings as
 * fallback for `$t` values starting with "shared.").
 */
export interface I18nToken {
  /**
   * Translation key. Dot-separated path through the JSON catalog
   * (e.g. "row.freeSpaces", "shared.value.open"). Keys starting with
   * "shared." resolve against the framework catalog; all other keys
   * resolve against the emitting integration's catalog first, framework
   * catalog as fallback.
   */
  $t: string;
  /**
   * ICU MessageFormat placeholder values for the resolved template
   * (e.g. {free: 3, capacity: 10} for "{free}/{capacity} free").
   */
  values?: Record<string, string | number>;
}

/**
 * A user-facing field that may either be a translation token or pure
 * pass-through data (e.g. a capacity number, a formatted price). Used for
 * value cells in data-source tables, where the right column legitimately
 * mixes translated text and raw numbers/strings.
 */
export type Translatable = I18nToken | string | number;

/**
 * Strings catalog as loaded from a per-integration `strings/<locale>.json`
 * file. Nested objects with string leaves; `$t` keys traverse the path.
 */
export type LocaleCatalog = Record<string, unknown>;

/**
 * Locale-keyed strings bundle. Both per-integration strings
 * (LoadedIntegrationMeta.strings) and the framework shared catalog use this
 * shape: `{ en: LocaleCatalog, de: LocaleCatalog, ... }`.
 */
export type LocaleStrings = Record<string, LocaleCatalog>;
