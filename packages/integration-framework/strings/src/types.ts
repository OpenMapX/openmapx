export type { I18nToken, Translatable } from "@openmapx/core";

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
