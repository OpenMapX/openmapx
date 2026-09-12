import type { RoadConditionEvent, RoadRestrictionFact } from "@openmapx/core";
import type { RoadConditionTranslate } from "./types";

/**
 * Formats already-normalized restriction facts for display.
 *
 * This is formatting only. It never decides whether a restriction applies,
 * never converts a wire value into a different unit on the wire, and never
 * relabels a comparator: a `gt 4.5 m` predicate says the event applies to
 * vehicles taller than 4.5 m, which is not a permitted maximum of 4.5 m.
 */

export interface RestrictionRow {
  label: string;
  value: string;
}

type DimensionFact = Extract<RoadRestrictionFact, { kind: "dimension" }>;

const DIMENSION_LABEL: Record<
  DimensionFact["meaning"],
  Record<DimensionFact["dimension"], string>
> = {
  maximum_permitted: {
    height: "restriction.maxHeight",
    width: "restriction.maxWidth",
    length: "restriction.maxLength",
    gross_weight: "restriction.maxGrossWeight",
  },
  event_applies_when: {
    height: "restriction.appliesHeight",
    width: "restriction.appliesWidth",
    length: "restriction.appliesLength",
    gross_weight: "restriction.appliesGrossWeight",
  },
};

const OPERATOR_KEY: Record<DimensionFact["operator"], string> = {
  gt: "restriction.operator.gt",
  gte: "restriction.operator.gte",
  eq: "restriction.operator.eq",
  lte: "restriction.operator.lte",
  lt: "restriction.operator.lt",
};

const SCOPE_KEY: Record<RoadRestrictionFact["scope"]["kind"], string> = {
  event_road: "restriction.scope.eventRoad",
  roadwork_phase: "restriction.scope.roadworkPhase",
  detour: "restriction.scope.detour",
};

const STATE_KEY: Record<RoadRestrictionFact["state"], string> = {
  active: "restriction.state.active",
  scheduled: "restriction.state.scheduled",
  ended: "restriction.state.ended",
  unknown: "restriction.state.unknown",
};

const DIRECTION_KEY: Record<RoadRestrictionFact["direction"]["value"], string> = {
  positive: "restriction.direction.positive",
  negative: "restriction.direction.negative",
  both: "restriction.direction.both",
  unknown: "restriction.direction.unknown",
};

const COMPLIANCE_KEY: Record<RoadRestrictionFact["context"]["compliance"], string> = {
  mandatory: "restriction.compliance.mandatory",
  advisory: "restriction.compliance.advisory",
  unknown: "restriction.compliance.unknown",
} as const;

const VEHICLE_KEY: Record<"truck", string> = { truck: "restriction.vehicle.truck" };
const USAGE_KEY: Record<"emergency_services", string> = {
  emergency_services: "restriction.usage.emergencyServices",
};

/**
 * Present a normalized quantity in the unit a driver reads. Tonnes are a
 * display convenience only — the wire value stays in kilograms, so a later
 * consumer never has to guess which unit it received.
 */
function displayQuantity(fact: DimensionFact): string {
  if (fact.unit === "kg" && fact.value % 1000 === 0) {
    return `${(fact.value / 1000).toLocaleString()} t`;
  }
  return `${fact.value.toLocaleString()} ${fact.unit}`;
}

function factLabel(fact: RoadRestrictionFact, translate: RoadConditionTranslate): string {
  if (fact.kind === "dimension") {
    return translate(DIMENSION_LABEL[fact.meaning][fact.dimension]);
  }
  return translate("restriction.appliesTo");
}

function factValue(fact: RoadRestrictionFact, translate: RoadConditionTranslate): string {
  if (fact.kind !== "dimension") {
    const key = fact.kind === "vehicle_class" ? VEHICLE_KEY[fact.value] : USAGE_KEY[fact.value];
    return translate(key);
  }
  const quantity = displayQuantity(fact);
  // A permitted maximum reads as the limit itself; every other comparator must
  // spell out the comparison, or "greater than 4.5 m" would look like a limit.
  return fact.meaning === "maximum_permitted"
    ? quantity
    : `${translate(OPERATOR_KEY[fact.operator])} ${quantity}`;
}

function scopeText(fact: RoadRestrictionFact, translate: RoadConditionTranslate): string {
  const parts = [translate(SCOPE_KEY[fact.scope.kind])];
  if (fact.scope.locationDescription) parts.push(fact.scope.locationDescription);
  return parts.join(" · ");
}

function windowText(
  fact: RoadRestrictionFact,
  translate: RoadConditionTranslate,
  formatDateTime: (value: string) => string,
  needsRefresh = false,
): string {
  const state = translate(needsRefresh ? "restriction.needsRefresh" : STATE_KEY[fact.state]);
  if (fact.validFrom === null && fact.validTo === null) {
    // No understood bound is "timing unknown", never "always".
    return `${state} · ${translate("restriction.state.unknown")}`;
  }
  const from = fact.validFrom === null ? "…" : formatDateTime(fact.validFrom);
  const to = fact.validTo === null ? "…" : formatDateTime(fact.validTo);
  return `${state} · ${from} – ${to}`;
}

function directionText(fact: RoadRestrictionFact, translate: RoadConditionTranslate): string {
  const parts = [translate(DIRECTION_KEY[fact.direction.value])];
  if (fact.direction.description) parts.push(fact.direction.description);
  return parts.join(" · ");
}

function scheduleText(
  schedules: NonNullable<RoadConditionEvent["schedule"]>,
  translate: RoadConditionTranslate,
): string {
  return schedules
    .map((entry) => {
      // Localized weekday names, matching how the popup renders an event's own
      // schedule; an unknown code falls back to itself rather than a raw key.
      const days =
        entry.byDay && entry.byDay.length > 0
          ? entry.byDay
              .map((day) => (WEEKDAY_CODES.has(day) ? translate(`schedule.days.${day}`) : day))
              .join(", ")
          : "";
      const band =
        entry.startTime && entry.endTime ? `${entry.startTime}–${entry.endTime}` : entry.startTime;
      const range =
        entry.startDate && entry.endDate
          ? `${entry.startDate} – ${entry.endDate}`
          : entry.startDate;
      return [days, band, range, entry.scheduleTimezone].filter(Boolean).join(", ");
    })
    .filter(Boolean)
    .join("; ");
}

/** Only http(s) links are shown; a source URL is still source-supplied text. */
function safeUrl(raw: string): string | undefined {
  return /^https?:\/\/\S+$/i.test(raw) ? raw : undefined;
}

const WEEKDAY_CODES = new Set(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

const ISO_DEFAULT = (value: string) => value;

export interface RestrictionRowOptions {
  /** Absolute-time formatter; defaults to the ISO instant as published. */
  formatDateTime?: (value: string) => string;
  /** The producer evaluation expired or the refresh failed; no local re-evaluation. */
  needsRefresh?: boolean;
}

/**
 * The ordered display rows for one event's restriction evidence. Returns an
 * empty list when the event makes no restriction claim, and a single
 * uninterpretable-details row when the envelope could not be validated.
 */
export function restrictionRows(
  event: RoadConditionEvent,
  translate: RoadConditionTranslate,
  options: RestrictionRowOptions = {},
): RestrictionRow[] {
  if (event.restrictionDetailsUnsupported === true) {
    return [
      { label: translate("restriction.heading"), value: translate("restriction.unsupported") },
    ];
  }
  const details = event.restrictionDetails;
  if (details === undefined) return [];
  const formatDateTime = options.formatDateTime ?? ISO_DEFAULT;
  const rows: RestrictionRow[] = [];
  const needsRefresh = options.needsRefresh === true || details.isStale;

  // Ended facts stay available in the source details but outside the list of
  // current restrictions, so a driver is not shown a limit that has lapsed.
  const current = details.facts.filter((fact) => fact.state !== "ended");
  for (const fact of current) {
    rows.push({ label: factLabel(fact, translate), value: factValue(fact, translate) });
    rows.push({ label: translate("restriction.scopeLabel"), value: scopeText(fact, translate) });
    rows.push({
      label: translate("restriction.validityLabel"),
      value: windowText(fact, translate, formatDateTime, needsRefresh),
    });
    rows.push({
      label: translate("restriction.directionLabel"),
      value: directionText(fact, translate),
    });
    if (fact.context.compliance !== "unknown") {
      rows.push({
        label: translate("restriction.complianceLabel"),
        value: translate(COMPLIANCE_KEY[fact.context.compliance]),
      });
    }
    if (fact.context.restrictionsLiftable === true) {
      rows.push({
        label: translate("restriction.contextLabel"),
        value: translate("restriction.liftable"),
      });
    }
    if (fact.schedule && fact.schedule.length > 0) {
      rows.push({
        label: translate("restriction.validityLabel"),
        value: scheduleText(fact.schedule, translate),
      });
    }
    if (fact.context.workingHours && fact.context.workingHours.length > 0) {
      rows.push({
        label: translate("restriction.workingHours"),
        value: scheduleText(fact.context.workingHours, translate),
      });
    }
    for (const comment of fact.context.comments ?? []) {
      rows.push({ label: translate("restriction.sourceComment"), value: comment.text });
    }
  }

  const ended = details.facts.filter((fact) => fact.state === "ended");
  for (const fact of ended) {
    rows.push({
      label: translate("restriction.endedLabel"),
      value: `${factLabel(fact, translate)}: ${factValue(fact, translate)} · ${windowText(fact, translate, formatDateTime, needsRefresh)}`,
    });
  }

  // Extent is never established in this release, so say so rather than letting
  // the marker's position imply the restricted stretch.
  rows.push({
    label: translate("restriction.extentLabel"),
    value: translate("restriction.extentNotVerified"),
  });

  if (details.completeness === "partial" || details.issues.length > 0) {
    rows.push({
      label: translate("restriction.issuesLabel"),
      value: translate("restriction.partial"),
    });
  }
  if (details.isStale || needsRefresh) {
    rows.push({
      label: translate("restriction.freshnessLabel"),
      value: translate(details.isStale ? "restriction.stale" : "restriction.needsRefresh"),
    });
  }

  const source = details.source;
  const sourceParts = [source.attribution, source.license, source.modificationNotice];
  const licenseUrl = safeUrl(source.licenseUrl);
  if (licenseUrl) sourceParts.push(licenseUrl);
  rows.push({ label: translate("restriction.sourceLabel"), value: sourceParts.join(" · ") });
  for (const notice of source.notices ?? []) {
    rows.push({ label: translate("restriction.noticeLabel"), value: notice });
  }

  return rows;
}

/**
 * The popup's named restriction fields, grouped so the card stays readable.
 * Each value is plain text and passes through the popup's existing escaping.
 */
export function restrictionPopupProperties(
  event: RoadConditionEvent,
  translate: RoadConditionTranslate,
  options: RestrictionRowOptions = {},
): Record<string, string> {
  const rows = restrictionRows(event, translate, options);
  if (rows.length === 0) return {};
  // Preserve fact order: regrouping by label separates limits from their own
  // phases, windows and directions and makes distinct predicates ambiguous.
  const out: Record<string, string> = {
    restrictionText: rows.map((row) => `${row.label}: ${row.value}`).join("\n"),
  };
  if (event.restrictionDetails !== undefined) {
    const states = new Set(event.restrictionDetails.facts.map((fact) => fact.state));
    const label = states.has("active")
      ? "restriction.state.active"
      : states.has("scheduled")
        ? "restriction.state.scheduled"
        : states.has("unknown")
          ? "restriction.state.unknown"
          : states.has("ended")
            ? "restriction.state.ended"
            : "restriction.state.unknown";
    out.restrictionStateText = translate(
      event.restrictionDetails.isStale
        ? "restriction.stale"
        : options.needsRefresh
          ? "restriction.needsRefresh"
          : label,
    );
  } else {
    out.restrictionStateText = translate("restriction.unsupported");
  }
  return out;
}

/**
 * Whether a parent road state should be labelled reported event context rather
 * than presented as an unconditional effect. A vehicle-conditioned closure is
 * not "Road closed".
 */
export function isConditionalRoadState(event: RoadConditionEvent): boolean {
  return event.restrictionDetails !== undefined || event.restrictionDetailsUnsupported === true;
}
