import type { OpeningHoursStatus } from "@openmapx/core";

/** Semantic palette token shared by list, peek, header and detail. */
export function openingHoursTone(
  status: OpeningHoursStatus,
): "text.secondary" | "success.main" | "error.main" {
  return status.isUnknown ? "text.secondary" : status.isOpen ? "success.main" : "error.main";
}
