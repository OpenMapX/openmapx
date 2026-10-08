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
   * (e.g. {free: 3, capacity: 10} for "{free}/{capacity} free"). A value may
   * itself be a token, resolved first, so one message can embed translated
   * parts, or an amount of money, formatted in the reader's locale.
   */
  values?: Record<string, string | number | I18nToken | MoneyValue>;
}

/** An amount of money in a token placeholder; the client formats it in its locale. */
export interface MoneyValue {
  $money: number;
  /** ISO 4217 code. */
  currency: string;
  /** The fraction digits always shown, when the price is quoted to more than the currency's own. */
  minDigits?: number;
}

/**
 * A user-facing field that may either be a translation token or pure
 * pass-through data (e.g. a capacity number, a formatted price). Used for
 * value cells in data-source tables, where the right column legitimately
 * mixes translated text and raw numbers/strings.
 */
export type Translatable = I18nToken | string | number;
