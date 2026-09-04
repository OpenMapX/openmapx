import IntlMessageFormat from "intl-messageformat";
import { defaultLocale, messages, resolveLocale } from "./config";

function lookup(catalogue: unknown, key: string): string | undefined {
  let value = catalogue;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return typeof value === "string" ? value : undefined;
}

/** ICU translations for server and background code, using the same catalogues as next-intl. */
export function createTranslator(localeInput?: string | null, namespace?: string) {
  const locale = resolveLocale(localeInput);
  const cache = new Map<string, IntlMessageFormat>();
  const fallbackRecords = new Map<
    string,
    { key: string; reason: "missing" | "invalid-message"; locale: string; fallbackLocale: string }
  >();
  const pathFor = (key: string) => (namespace ? `${namespace}.${key}` : key);
  const fallbackFormatter = (path: string): IntlMessageFormat => {
    const fallback = lookup(messages[defaultLocale], path);
    if (fallback === undefined) throw new Error(`Missing translation: ${path}`);
    try {
      return new IntlMessageFormat(fallback, defaultLocale, undefined, { ignoreTag: true });
    } catch (error) {
      throw new Error(`Invalid fallback translation: ${path}`, { cause: error });
    }
  };
  const translate = (
    key: string,
    values: Record<string, string | number | boolean | Date> = {},
  ): string => {
    let formatter = cache.get(key);
    if (!formatter) {
      const path = pathFor(key);
      const text = lookup(messages[locale], path);
      if (text === undefined) {
        formatter = fallbackFormatter(path);
        if (locale !== defaultLocale)
          fallbackRecords.set(path, {
            key: path,
            reason: "missing",
            locale,
            fallbackLocale: defaultLocale,
          });
      } else {
        try {
          formatter = new IntlMessageFormat(text, locale, undefined, { ignoreTag: true });
        } catch (error) {
          if (locale === defaultLocale)
            throw new Error(`Invalid fallback translation: ${path}`, { cause: error });
          formatter = fallbackFormatter(path);
          fallbackRecords.set(path, {
            key: path,
            reason: "invalid-message",
            locale,
            fallbackLocale: defaultLocale,
          });
        }
      }
      cache.set(key, formatter);
    }
    let result: ReturnType<IntlMessageFormat["format"]>;
    try {
      result = formatter.format(values);
    } catch (error) {
      const path = pathFor(key);
      if (locale === defaultLocale || fallbackRecords.has(path))
        throw new Error(`Invalid fallback translation: ${path}`, { cause: error });
      formatter = fallbackFormatter(path);
      cache.set(key, formatter);
      fallbackRecords.set(path, {
        key: path,
        reason: "invalid-message",
        locale,
        fallbackLocale: defaultLocale,
      });
      try {
        result = formatter.format(values);
      } catch (fallbackError) {
        throw new Error(`Invalid fallback translation: ${path}`, { cause: fallbackError });
      }
    }
    if (typeof result !== "string") throw new Error(`Translation is not text: ${key}`);
    return result;
  };
  translate.has = (key: string): boolean =>
    lookup(messages[locale], pathFor(key)) !== undefined ||
    lookup(messages[defaultLocale], pathFor(key)) !== undefined;
  translate.fallbacks = () => [...fallbackRecords.values()];
  return translate;
}
