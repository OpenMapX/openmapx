import type { Mode } from "@motis-project/motis-client";
import { motisMode } from "@openmapx/mobility-core/motis-radar";
import type { TransportMode } from "@openmapx/mobility-core/transit";

/** Deduplicate the transport modes of MOTIS mode names. */
export function uniqueModes(modes: (Mode | string)[]): TransportMode[] {
  return [...new Set(modes.map((m) => motisMode(m)))];
}
