import { type Locale, locales, messages } from "./config";
import { createNavigationCueFormatter } from "./navigationCueFormatter";

export {
  type FormatCueOptions,
  NavigationCueError,
  type NavigationCueIntent,
} from "./navigationCueFormatter";

/**
 * Cue formatting over the full registered catalogues, for headless consumers
 * (the mobile background task) and the package barrel. Browser bundles use
 * `./navigationCuesCompact`, which formats identically from a cue-only catalogue.
 */
const registry = createNavigationCueFormatter(
  Object.fromEntries(locales.map((locale) => [locale, messages[locale].navigation])) as Partial<
    Record<Locale, Record<string, unknown>>
  > as Record<Locale, Record<string, unknown>>,
);

export const { formatCueDistance, formatNavigationCue, resetNavigationCueCache } = registry;
