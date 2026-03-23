import type { OpeningHoursFilter } from "../stores/openingHoursStore";
import type { CategoryPlace } from "../types/category";
import { isAlwaysOpen, isOpenAt, parseOpeningHours } from "./openingHours";

/** Builds a Date for a specific day index (0=Sun) and hour in the current week. */
function buildDateForDayHour(dayIdx: number | null, hour: number | null): Date {
  const now = new Date();
  if (dayIdx !== null) {
    const todayIdx = now.getDay();
    const diff = (dayIdx - todayIdx + 7) % 7;
    now.setDate(now.getDate() + diff);
  }
  if (hour !== null) {
    now.setHours(hour, 0, 0, 0);
  }
  return now;
}

/** Filters category search results by the active opening-hours filter. */
export function applyHoursFilter(
  results: CategoryPlace[],
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
): CategoryPlace[] {
  if (filter === "any") return results;
  if (filter === "open_24h") return results.filter((p) => isAlwaysOpen(p.openingHours));
  if (filter === "open_now")
    return results.filter((p) => {
      if (p.isOpen !== undefined) return p.isOpen;
      return parseOpeningHours(p.openingHours)?.isOpen === true;
    });
  if (filter === "open_at") {
    if (openAtDay === null && openAtHour === null) return results;
    const date = buildDateForDayHour(openAtDay, openAtHour);
    return results.filter((p) => isOpenAt(p.openingHours, date));
  }
  return results;
}
