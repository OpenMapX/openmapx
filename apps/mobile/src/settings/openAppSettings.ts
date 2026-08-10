/**
 * Opening the OS settings the app is allowed to send someone to.
 *
 * The command carries a target from a closed set, never a URI. A URI parameter
 * would make this a general "open anything" primitive reachable from the
 * WebView, which is precisely what the fixed-origin design exists to rule out —
 * and on Android an arbitrary intent URI is a way out of the app entirely.
 */

export type SettingsTarget = "location" | "notifications" | "application";
export type SettingsOpenStatus = "opened" | "unavailable" | "cancelled";

export interface SettingsOpener {
  /** Opens the OS page for the app itself. */
  openSettings(): Promise<void>;
  /** Opens a platform-specific page, when the platform has a distinct one. */
  openTarget?(target: SettingsTarget): Promise<boolean>;
}

/**
 * Sends the user to the right settings page.
 *
 * Falls back to the application page rather than failing: from the app's own
 * settings a user can always reach location and notifications, so a platform
 * with no dedicated page is a slightly longer walk, not a dead end.
 */
export async function openAppSettings(
  target: SettingsTarget,
  opener: SettingsOpener,
): Promise<SettingsOpenStatus> {
  try {
    if (opener.openTarget) {
      const opened = await opener.openTarget(target);
      if (opened) return "opened";
    }
    await opener.openSettings();
    return "opened";
  } catch {
    return "unavailable";
  }
}
