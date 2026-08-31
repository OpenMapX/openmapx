import type { Mode } from "@motis-project/motis-client";
import { motisMode } from "@openmapx/mobility-core/motis-radar";
import type { TransportMode } from "@openmapx/mobility-core/transit";

/**
 * Map a MOTIS leg to our TransportMode, refining `RENTAL` by GBFS form factor:
 * car-like rentals (CAR/MOPED) become "driving"; everything else uses the static
 * {@link motisMode} table (RENTAL/BIKE → cycling). Keeps the form-factor decision
 * in one place instead of patching motisMode's output at the call site.
 */
export function motisLegMode(leg: {
  mode?: Mode | string;
  rental?: { formFactor?: string | null } | null;
}): TransportMode {
  const form = leg.rental?.formFactor;
  if (form === "CAR" || form === "MOPED") return "driving";
  return motisMode(leg.mode);
}

/** Deduplicate mapped transport modes. */
export function uniqueModes(modes: (Mode | string)[]): TransportMode[] {
  return [...new Set(modes.map((m) => motisMode(m)))];
}
