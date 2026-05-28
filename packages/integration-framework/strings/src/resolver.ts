import { IntlMessageFormat } from "intl-messageformat";
import type { I18nToken, LocaleStrings } from "./types";

export interface ResolveOptions {
  /** Active locale (e.g. "en", "de"). */
  locale: string;
  /** Fallback locale used when `locale` is missing the key (typically "en"). */
  fallbackLocale: string;
  /** Framework shared strings — always consulted for `shared.*` keys. */
  shared: LocaleStrings;
  /** Per-integration strings — consulted first for non-`shared.*` keys. */
  integration: LocaleStrings | undefined;
}

/**
 * Resolve an `I18nToken` to a display string.
 *
 * Lookup order:
 *   - For keys starting with "shared.": framework catalog (active locale →
 *     fallback locale).
 *   - For other keys: integration catalog (active → fallback) → framework
 *     catalog (active → fallback).
 *
 * When no catalog yields a string, returns the bare key. This produces a
 * visible bug (the user sees `row.freeSpaces` instead of "Free Spaces") which
 * surfaces faster than a silent English leak.
 */
export function resolveToken(token: I18nToken, opts: ResolveOptions): string {
  const key = token.$t;
  const isShared = key.startsWith("shared.");

  // Build the lookup plan: each entry is the catalog to consult and the
  // effective key path to walk inside it. The framework catalog is always
  // consulted under the `shared` subtree, so non-`shared.*` keys consulted as
  // a framework fallback are auto-prefixed with `shared.`.
  const plan: { catalog: LocaleStrings; key: string }[] = [];
  if (!isShared && opts.integration) plan.push({ catalog: opts.integration, key });
  plan.push({ catalog: opts.shared, key: isShared ? key : `shared.${key}` });

  for (const { catalog, key: effectiveKey } of plan) {
    const value =
      lookupKey(catalog[opts.locale], effectiveKey) ??
      lookupKey(catalog[opts.fallbackLocale], effectiveKey);
    if (value !== undefined) return format(value, opts.locale, token.values);
  }

  return key;
}

function lookupKey(catalog: unknown, key: string): string | undefined {
  if (typeof catalog !== "object" || catalog === null) return undefined;
  const parts = key.split(".");
  let cur: unknown = catalog;
  for (const part of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  // Treat an empty string as a missing entry so resolution continues down the
  // fallback chain (active locale → fallback locale → framework → bare key)
  // rather than rendering a blank label.
  return typeof cur === "string" && cur !== "" ? cur : undefined;
}

function format(
  template: string,
  locale: string,
  values: Record<string, string | number> | undefined,
): string {
  if (!values) return template;
  // ICU MessageFormat — same engine next-intl uses, so plural/select syntax
  // works identically between server-emitted templates and client-side strings.
  // A malformed template (unbalanced braces, bad plural syntax) throws on
  // construction; fall back to the raw template so a single bad catalog entry
  // degrades to visible-but-unformatted text instead of crashing the render.
  try {
    return new IntlMessageFormat(template, locale).format(values) as string;
  } catch {
    return template;
  }
}
