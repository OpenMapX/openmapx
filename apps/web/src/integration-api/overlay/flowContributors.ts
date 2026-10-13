import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForFields,
  parseFieldContributors,
} from "@openmapx/mobility-core/contributors";
import { OSM_ATTRIBUTION } from "@/lib/map";

export type FlowPresentation = "casing" | "color" | "popup";

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

/** Project the versioned OpenConditions FLOW receipt onto this presentation. */
export function flowFeatureContributors(
  properties: Record<string, unknown>,
  presentation: FlowPresentation,
): Attribution[] {
  const captured = parseFieldContributors(properties.field_contributors);
  // Old OC tiles still have proven OSM geometry. They cannot establish exact
  // measurement ownership; collection source lists are rights dependencies.
  const fields = { geometry: [OSM_ATTRIBUTION], ...captured };
  const displayed = ["geometry"];
  if (presentation === "color") {
    displayed.push(present(properties.speed_ratio) ? "ratio" : "los", "confidence");
  } else if (presentation === "popup") {
    for (const [property, field] of [
      ["current_kph", "speed"],
      ["free_flow_kph", "freeFlow"],
      ["speed_ratio", "ratio"],
      ["los", "los"],
      ["confidence", "confidence"],
    ]) {
      if (present(properties[property])) displayed.push(field);
    }
  }
  return contributorsForFields(fields, displayed);
}
