import { de, en } from "@openmapx/i18n";
import type { MobileLocale } from "../../config/nativeCopy";

/**
 * Localised copy for the permission surfaces.
 *
 * Read the same way as the rest of the native shell: a plain object lookup
 * against the canonical catalogs, with no ICU formatter, no React context and no
 * DOM — these strings must render from a screen the headless task may have
 * caused, and they never interpolate.
 */
const CATALOGS: Record<MobileLocale, Record<string, unknown>> = { en, de };

export type PermissionCopyKey =
  | "title"
  | "purpose"
  | "processing"
  | "transmission"
  | "stopping"
  | "precise"
  | "foregroundOnlyNote"
  | "continue"
  | "foregroundOnly"
  | "notNow"
  | "settingsTitle"
  | "settingsBackground"
  | "settingsPrecise"
  | "settingsCannotEscalate"
  | "openSettings"
  | "deniedTitle"
  | "deniedBody"
  | "foregroundOnlyPausedTitle"
  | "foregroundOnlyPausedBody";

export function permissionCopy(locale: MobileLocale, key: PermissionCopyKey): string {
  const namespace = CATALOGS[locale].mobilePermissions as Record<string, string> | undefined;
  const fallback = (en.mobilePermissions as Record<string, string>)[key];
  return namespace?.[key] ?? fallback ?? key;
}
