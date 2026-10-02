import type { RoadConditionEvent, RoadConditionSeverityLabel } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";

/** Severity labels, mildest first; `unknown` ranks below every label. */
export const SEVERITY_RANK: Record<RoadConditionSeverityLabel, number> = {
  unknown: 0,
  minor: 1,
  moderate: 2,
  major: 3,
  critical: 4,
};

export const SEVERITY_LABELS = Object.keys(SEVERITY_RANK) as RoadConditionSeverityLabel[];

export function isSeverityLabel(value: unknown): value is RoadConditionSeverityLabel {
  return SEVERITY_LABELS.includes(value as RoadConditionSeverityLabel);
}

/** Severity → marker disc color, the canonical road-conditions ramp. */
export const SEVERITY_COLORS: Record<RoadConditionSeverityLabel, string> = {
  critical: "#7e0023",
  major: "#cc0033",
  moderate: "#ff9933",
  minor: "#ffde33",
  unknown: "#8a8a8a",
};

/** Affected-road line color by the feature's `severity` label (matches the marker ramp). */
export const SEVERITY_LINE_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "severity"],
  "critical",
  SEVERITY_COLORS.critical,
  "major",
  SEVERITY_COLORS.major,
  "moderate",
  SEVERITY_COLORS.moderate,
  "minor",
  SEVERITY_COLORS.minor,
  SEVERITY_COLORS.unknown,
];

/** The most severe situation of a non-empty list; the first wins a tie. */
export function mostSevereEvent(events: RoadConditionEvent[]): RoadConditionEvent {
  const [first, ...rest] = events;
  if (!first) throw new Error("Cannot select severity from an empty road-condition group");
  return rest.reduce(
    (best, event) =>
      SEVERITY_RANK[event.severity.label] > SEVERITY_RANK[best.severity.label] ? event : best,
    first,
  );
}
