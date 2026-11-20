// biome-ignore lint/style/noRestrictedImports: test helpers are never bundled.
import en from "@openmapx/i18n/locales/en.json";
import { type AbstractIntlMessages, createTranslator } from "next-intl";

/**
 * A translator over the real English catalogue for unit tests of helpers that
 * receive one. Tests that mock next-intl take theirs from the mocked
 * `useTranslations` instead.
 */
export function catalogTranslator(
  namespace: string,
): (key: string, values?: Record<string, string | number>) => string {
  const messages: AbstractIntlMessages = en;
  const t = createTranslator({ locale: "en", messages, namespace });
  // An untyped namespace types the values argument loosely; the catalogue checks the message.
  return (key, values) => t(key, values as never);
}
