import { de, en } from "@openmapx/i18n";
import { type MobileLocale, resolveMobileLocale } from "../../config/nativeCopy";

/**
 * Localised copy for the native shell surfaces.
 *
 * These strings come from the same canonical `@openmapx/i18n` catalogs the web
 * app uses, so there is exactly one place a translator edits them. The lookup is
 * a plain object read rather than an ICU formatter because none of the shell
 * strings interpolate — the navigation cues that do get the real formatter in
 * `@openmapx/i18n/navigationCues`.
 *
 * This module deliberately avoids `next-intl`, React context and any DOM access
 * so it stays usable from the headless background task.
 */
const CATALOGS: Record<MobileLocale, Record<string, unknown>> = { en, de };

export type ShellCopyKey =
  | "loading"
  | "loadErrorTitle"
  | "loadErrorBody"
  | "retry"
  | "offlineTitle"
  | "offlineBody"
  | "fatalConfigTitle"
  | "fatalConfigBody"
  | "openNetworkSettings";

export function shellCopy(locale: MobileLocale, key: ShellCopyKey): string {
  const namespace = CATALOGS[locale].mobileShell as Record<string, string> | undefined;
  const fallback = (en.mobileShell as Record<string, string>)[key];
  return namespace?.[key] ?? fallback ?? key;
}

/**
 * The device's preferred locale narrowed to one this release supports. Hermes
 * ships full ICU on both platforms, but the lookup is guarded because a runtime
 * without it would otherwise crash the shell before it can render anything.
 */
export function deviceMobileLocale(): MobileLocale {
  try {
    return resolveMobileLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return "en";
  }
}
