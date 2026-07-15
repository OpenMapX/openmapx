import type { RentalReturnConstraint } from "./types/shared-mobility.js";

export function normalizeRentalReturnConstraint(
  value: string | null | undefined,
): RentalReturnConstraint | undefined {
  switch (value?.trim().toLowerCase()) {
    case "none":
      return "none";
    case "any_station":
      return "any_station";
    case "roundtrip_station":
      return "roundtrip_station";
    default:
      return undefined;
  }
}
