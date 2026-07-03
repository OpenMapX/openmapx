import type { OpeningHoursFilter } from "../stores/openingHoursStore";
import type { CategoryPlace } from "../types/category";
import { isOpenAtSlot } from "./openingHoursClient";

/**
 * Filters category search results by the active opening-hours filter.
 *
 * Operates purely on the server-precomputed `openingHoursInfo` field — no
 * `opening_hours` library import — so it is safe to call from the browser.
 */
export function applyHoursFilter(
  results: CategoryPlace[],
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): CategoryPlace[] {
  if (filter === "any") return results;
  if (filter === "open_24h") {
    return results.filter((p) => p.openingHoursInfo?.isAlwaysOpen === true);
  }
  if (filter === "open_now") {
    return results.filter((p) => {
      if (p.openingHoursInfo?.status?.isOpen !== undefined) {
        return p.openingHoursInfo.status.isOpen === true;
      }
      return p.isOpen === true;
    });
  }
  if (filter === "open_at") {
    if (openAtDay === null && openAtHour === null) return results;
    return results.filter((p) => isOpenAtSlot(p.openingHoursInfo, openAtDay, openAtHour));
  }
  return results;
}
