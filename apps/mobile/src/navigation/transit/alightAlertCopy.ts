import type { MobileLocale } from "../../../config/nativeCopy";
import type { AlightAlertCopy } from "./AlightAlertPolicy";

/**
 * The get-off notification's text.
 *
 * Composed natively because the notification is scheduled with the operating
 * system and fires whether or not a page exists. The stop and platform come
 * from the validated itinerary, never from the page.
 */
const COPY: Record<MobileLocale, AlightAlertCopy> = {
  en: {
    title: (stop) => `Get off at ${stop}`,
    body: (stop, basis, platform) =>
      [
        `Your stop ${stop} is coming up.`,
        platform ? `Platform ${platform}.` : null,
        basis === "schedule" ? "Timed from the timetable." : null,
      ]
        .filter(Boolean)
        .join(" "),
  },
  de: {
    title: (stop) => `Aussteigen: ${stop}`,
    body: (stop, basis, platform) =>
      [
        `Gleich erreichst du ${stop}.`,
        platform ? `Gleis ${platform}.` : null,
        basis === "schedule" ? "Nach Fahrplan berechnet." : null,
      ]
        .filter(Boolean)
        .join(" "),
  },
};

export function alightAlertCopy(locale: MobileLocale): AlightAlertCopy {
  return COPY[locale];
}
