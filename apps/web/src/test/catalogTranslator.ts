// biome-ignore lint/style/noRestrictedImports: test helpers are never bundled.
import en from "@openmapx/i18n/locales/en.json";
import { type AbstractIntlMessages, createTranslator } from "next-intl";
import type { AdminTranslator } from "@/lib/admin/adminTranslator";

/**
 * A translator over the real English catalogue for unit tests of helpers that
 * receive one. Tests that mock next-intl take theirs from the mocked
 * `useTranslations` instead.
 */
export function catalogTranslator<Namespace extends string>(
  namespace: Namespace,
): AdminTranslator<Namespace> {
  const messages: AbstractIntlMessages = en;
  return createTranslator({
    locale: "en",
    messages,
    namespace: namespace as never,
  }) as unknown as AdminTranslator<Namespace>;
}
