import type { OpeningHoursFilter } from "../stores/openingHoursStore";
import type { CategoryPlace } from "../types/category";
import { isOpenAt, parseOpeningHours } from "./openingHours";

/** Filters category search results by the active opening-hours filter. */
export function applyHoursFilter(
  results: CategoryPlace[],
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): CategoryPlace[] {
  if (filter === "any") return results;
  if (filter === "open_24h") return results.filter((p) => p.openingHours === "24/7");
  if (filter === "open_now")
    return results.filter((p) => {
      if (p.isOpen !== undefined) return p.isOpen;
      return parseOpeningHours(p.openingHours)?.isOpen === true;
    });
  if (filter === "open_at") {
    if (openAtDay === null && openAtHour === null) return results;
    return results.filter((p) => isOpenAt(p.openingHours, openAtDay, openAtHour));
  }
  return results;
}
