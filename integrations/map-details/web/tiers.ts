/** Device tiers for the objects budget (spec §7.1). */

export type Tier = "full" | "light";

/** Provisional until the phone measurement (spec §9). */
export const TIER_BUDGETS: Record<Tier, { trees: number; furniture: number }> = {
  full: { trees: 6000, furniture: 1500 },
  light: { trees: 2000, furniture: 500 },
};

/** Light for touch devices, 4 GB or less, or fewer than six cores; unknown values count as full. */
export function detectTier(nav: {
  pointerCoarse: boolean;
  deviceMemory?: number;
  hardwareConcurrency?: number;
}): Tier {
  if (nav.pointerCoarse) return "light";
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return "light";
  if (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency < 6) return "light";
  return "full";
}
