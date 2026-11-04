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
    body: (stop, _basis, platform) =>
      [
        `Your stop ${stop} is coming up.`,
        platform ? `Platform ${platform}.` : null,
        "Time estimate; check the stops on your service.",
      ]
        .filter(Boolean)
        .join(" "),
  },
  de: {
    title: (stop) => `Aussteigen: ${stop}`,
    body: (stop, _basis, platform) =>
      [
        `Gleich erreichst du ${stop}.`,
        platform ? `Gleis ${platform}.` : null,
        "Zeitschätzung; beachte die Haltestellen deiner Verbindung.",
      ]
        .filter(Boolean)
        .join(" "),
  },
};

export function alightAlertCopy(locale: MobileLocale): AlightAlertCopy {
  return COPY[locale];
}
