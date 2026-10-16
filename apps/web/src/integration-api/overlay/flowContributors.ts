import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForFields,
  readCapturedFieldContributors,
} from "@openmapx/mobility-core/contributors";
import { OSM_ATTRIBUTION } from "@/lib/map";

export type FlowPresentation = "casing" | "color" | "popup";

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function displayedFields(
  properties: Record<string, unknown>,
  presentation: FlowPresentation,
): string[] {
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
  return displayed;
}

/** Exact projection inputs; segment IDs and numeric values do not change their suppliers. */
export function flowFeatureContributorKey(
  properties: Record<string, unknown>,
  presentation: FlowPresentation,
): string {
  const raw = properties.field_contributors;
  // MVT already contains JSON text. Avoid parsing it (or re-escaping it inside
  // another JSON string) for every road segment before the tracker can group it.
  return `${JSON.stringify(displayedFields(properties, presentation))}:${typeof raw === "string" ? raw : JSON.stringify(raw)}`;
}

/** Project the versioned OpenConditions FLOW receipt onto this presentation. */
export function flowFeatureContributors(
  properties: Record<string, unknown>,
  presentation: FlowPresentation,
): Attribution[] {
  const captured = readCapturedFieldContributors(properties.field_contributors);
  // Road-segment geometry comes from OSM. Missing measurement receipts never
  // establish ownership; collection source lists are rights dependencies.
  const fields = { geometry: [OSM_ATTRIBUTION], ...captured };
  return contributorsForFields(fields, displayedFields(properties, presentation));
}
