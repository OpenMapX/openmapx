import {
  effectInForceAt,
  effectValidity,
  formatDuration,
  isRestrictionEvidence,
  localizedTextFor,
  type RoadConditionEffect,
  type RoadConditionEvent,
  VEHICLE_CLASSES,
  type VehicleApplicability,
} from "@openmapx/core";
import type { RoadConditionTranslate } from "./types";

/**
 * Formats a situation's effects for display: what each one does to traffic,
 * which vehicles it binds and whether it is in force at the instant shown.
 *
 * This is formatting only. It never decides whether a rule applies to a
 * vehicle, never widens an unknown vehicle scope to all traffic, and never
 * relabels a comparator: `lt 4 m` reads "less than 4 m", not a 4 m limit.
 */

export interface EffectFormatOptions {
  translate: RoadConditionTranslate;
  locale: string;
  /** Absolute-time formatter; defaults to the ISO instant as published. */
  formatDateTime?: (value: string) => string;
  /** The instant each effect's state is evaluated at. */
  at: Date;
}

type Quantity = { value: number; unit: string };

const KNOWN_VEHICLE_CLASSES = new Set<string>(VEHICLE_CLASSES);

const CLOSURE_SCOPES = new Set([
  "road",
  "carriageway",
  "ramp",
  "junction",
  "bridge",
  "tunnel",
  "sidewalk",
  "cycleway",
  "rest_area",
  "facility",
]);

function humanizeToken(raw: string): string {
  const value = raw.replace(/[_-]+/g, " ").trim();
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * A quantity in the unit a driver reads. Tonnes are a display convenience
 * only; the effect keeps the unit its producer published.
 */
function quantityText(q: Quantity): string {
  if (q.unit === "kg" && q.value % 1000 === 0) return `${(q.value / 1000).toLocaleString()} t`;
  if (q.unit === "s") return formatDuration(q.value);
  return `${q.value.toLocaleString()} ${q.unit}`;
}

function selectorText(
  selector: NonNullable<VehicleApplicability["include"]>[number],
  translate: RoadConditionTranslate,
): string {
  const base = selector.class
    ? KNOWN_VEHICLE_CLASSES.has(selector.class)
      ? translate(`vehicle.${selector.class}`)
      : humanizeToken(selector.class)
    : (selector.raw?.join(", ") ?? translate("vehicles.unspecified"));
  const conditional =
    selector.when !== undefined ||
    selector.hazmat !== undefined ||
    selector.emission !== undefined ||
    selector.usage !== undefined ||
    selector.fuel !== undefined ||
    selector.hovMin !== undefined;
  return conditional ? `${base} (${translate("vehicles.conditional")})` : base;
}

/** The vehicles an effect binds, or undefined when it binds every vehicle. */
export function applicabilityText(
  applicability: VehicleApplicability,
  translate: RoadConditionTranslate,
): string | undefined {
  if (applicability.kind === "unknown") {
    return applicability.raw?.length
      ? `${translate("vehicles.unspecified")}: ${applicability.raw.join(", ")}`
      : translate("vehicles.unspecified");
  }
  const except = applicability.except?.length
    ? translate("vehicles.except", {
        vehicles: applicability.except.map((s) => selectorText(s, translate)).join(", "),
      })
    : undefined;
  if (applicability.kind === "all") return except;
  const included = (applicability.include ?? []).map((s) => selectorText(s, translate)).join(", ");
  return [included || translate("vehicles.unspecified"), except].filter(Boolean).join(" ");
}

/** Delay bands with a label in the catalog, by DATEX `DelayBandEnum`. */
const DELAY_BANDS = new Set([
  "negligible",
  "up_to_ten_minutes",
  "between_ten_minutes_and_thirty_minutes",
  "between_thirty_minutes_and_one_hour",
  "between_one_hour_and_three_hours",
  "between_three_hours_and_six_hours",
  "longer_than_six_hours",
]);

/**
 * Delay descriptions with a label in the catalog, by DATEX `DelaysTypeEnum`.
 * Plain `delays` says no more than the effect itself and is not repeated.
 */
const DELAY_TYPES = new Set(["delays_of_uncertain_duration", "long_delays", "very_long_delays"]);

type LaneRestriction = Extract<RoadConditionEffect, { kind: "lane_restriction" }>;

/**
 * How many lanes a lane restriction closes, restricts and leaves open. A
 * restricted lane is restricted fully or partially, so it is not a closed
 * one; a closed lane is also a restricted one, so restricted lanes are named
 * apart only where more are restricted than closed. Without counts, the
 * closed and restricted lanes are counted from the per-lane statuses; open
 * ones are not, as a source may list only the lanes it affects.
 */
function laneCountsText(
  effect: LaneRestriction,
  translate: RoadConditionTranslate,
): string | undefined {
  const listed = effect.lanes ?? [];
  const counted = (statuses: (status: string) => boolean) =>
    listed.length > 0 ? listed.filter((lane) => statuses(lane.status)).length : undefined;
  const total = effect.lanesTotal;
  const closed = effect.lanesClosed ?? counted((status) => status === "closed");
  const restricted = effect.lanesRestricted ?? counted((status) => status !== "open");
  const open = effect.lanesOperational;
  const restrictedBeyondClosed = restricted !== undefined && restricted > (closed ?? 0);
  const parts = restrictedBeyondClosed
    ? [
        total !== undefined
          ? translate("effect.lanesRestrictedOf", { restricted, total })
          : translate("effect.lanesRestricted", { restricted }),
        closed ? translate("effect.lanesClosed", { closed }) : undefined,
      ]
    : [
        closed !== undefined && total !== undefined
          ? translate("effect.lanesClosedOf", { closed, total })
          : closed !== undefined
            ? translate("effect.lanesClosed", { closed })
            : undefined,
      ];
  if (open !== undefined) parts.push(translate("effect.lanesOpen", { open }));
  const text = parts.filter(Boolean).join(", ");
  return text || undefined;
}

/** What the effect does, as a label and an optional value. */
function describe(
  effect: RoadConditionEffect,
  { translate, locale }: EffectFormatOptions,
): { label: string; value?: string } {
  const label = translate(`effect.${effect.kind}`);
  switch (effect.kind) {
    case "closure":
      return {
        label,
        value: CLOSURE_SCOPES.has(effect.scope)
          ? translate(`scope.${effect.scope}`)
          : humanizeToken(effect.scope),
      };
    case "lane_restriction": {
      const lanes = laneCountsText(effect, translate);
      return { label, value: lanes ?? humanizeToken(effect.vehicleImpact) };
    }
    case "speed_limit":
      return {
        label,
        value: [
          quantityText(effect.limit),
          effect.advisory ? translate("effect.advisorySpeed") : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "delay": {
      const parts = [
        effect.delay
          ? `+${quantityText(effect.delay)}`
          : effect.delayBand
            ? DELAY_BANDS.has(effect.delayBand)
              ? translate(`effect.delayBand.${effect.delayBand}`)
              : humanizeToken(effect.delayBand)
            : undefined,
        effect.delay === undefined && effect.delayType && effect.delayType !== "delays"
          ? DELAY_TYPES.has(effect.delayType)
            ? translate(`effect.delayType.${effect.delayType}`)
            : humanizeToken(effect.delayType)
          : undefined,
        effect.queueLength
          ? translate("effect.queue", { length: quantityText(effect.queueLength) })
          : undefined,
      ].filter(Boolean);
      return { label, ...(parts.length ? { value: parts.join(", ") } : {}) };
    }
    case "access":
      return {
        label,
        value: [humanizeToken(effect.mode), effect.chainLevel].filter(Boolean).join(" "),
      };
    case "dimension_limit": {
      const value = `${translate(`dimension.${effect.dimension}`)} ${translate(
        `operator.${effect.operator}`,
      )} ${quantityText(effect.value)}`;
      return {
        label,
        value:
          effect.meaning === "physical_limit" ? `${value} (${translate("physicalLimit")})` : value,
      };
    }
    case "hazmat":
      return {
        label,
        value: [
          translate(`hazmat.${effect.mode}`),
          effect.adrTunnelCategory
            ? translate("hazmat.tunnelCategory", { category: effect.adrTunnelCategory })
            : undefined,
          effect.unClasses?.length
            ? translate("hazmat.unClasses", { classes: effect.unClasses.join(", ") })
            : undefined,
        ]
          .filter(Boolean)
          .join(", "),
      };
    case "detour": {
      const via = (effect.via ?? [])
        .map((road) => road.ref ?? localizedTextFor(road.name, locale))
        .filter((road): road is string => Boolean(road));
      const parts = [
        localizedTextFor(effect.description, locale),
        via.length ? translate("effect.via", { roads: via.join(", ") }) : undefined,
        effect.signed ? translate("effect.signed") : undefined,
      ].filter(Boolean);
      return { label, ...(parts.length ? { value: parts.join(", ") } : {}) };
    }
    case "contraflow":
      return { label };
    case "advisory":
      return { label, value: localizedTextFor(effect.text, locale) };
    case "unsupported":
      return {
        label,
        value: localizedTextFor(effect.summary, locale) ?? translate("effect.notInterpreted"),
      };
  }
}

/** Operator action statuses under which an action is not in place, each with its own text. */
const ACTIONS_NOT_IN_PLACE = new Set(["requested", "approved", "rejected"]);

/** Lifecycles that keep an effect out of force inside its window, each with its own text. */
const LIFECYCLES_NOT_IN_FORCE = new Set(["planned", "suspended", "unknown"]);

/**
 * The effect's state at `at`: in force, over, an operator action not yet (or
 * never) in place, starting later, held out of force by its lifecycle, or
 * outside its windows. It says "in force" exactly when the effect is, so it
 * agrees with what closes a road or delays traffic.
 */
export function effectStateText(
  event: Pick<RoadConditionEvent, "validity">,
  effect: RoadConditionEffect,
  { translate, at, formatDateTime = (value) => value }: EffectFormatOptions,
): string {
  const validity = effectValidity(event, effect);
  if (effectInForceAt(event, effect, at)) return translate("state.active");
  if (
    validity.status === "ended" ||
    validity.status === "cancelled" ||
    (validity.end && Date.parse(validity.end) < at.getTime())
  ) {
    return translate("state.ended");
  }
  if (effect.actionStatus && ACTIONS_NOT_IN_PLACE.has(effect.actionStatus)) {
    return translate(`state.action.${effect.actionStatus}`);
  }
  if (validity.start && Date.parse(validity.start) > at.getTime()) {
    return translate("state.scheduled", { date: formatDateTime(validity.start) });
  }
  if (LIFECYCLES_NOT_IN_FORCE.has(validity.status)) {
    return translate(`state.lifecycle.${validity.status}`);
  }
  return translate("state.inactive");
}

/**
 * One display line per effect: what it does, which vehicles it binds, its
 * state at the instant shown, and — for restriction evidence — that it was not
 * fully interpreted.
 */
export function effectLines(event: RoadConditionEvent, options: EffectFormatOptions): string[] {
  return event.effects.map((effect) => {
    const { label, value } = describe(effect, options);
    const qualifiers = [
      applicabilityText(effect.applicability, options.translate),
      effectStateText(event, effect, options),
      effect.compliance === "advisory" && effect.kind !== "advisory"
        ? options.translate("compliance.advisory")
        : undefined,
      isRestrictionEvidence(effect) && effect.kind !== "unsupported"
        ? options.translate("effect.partial")
        : undefined,
    ].filter(Boolean);
    return [value ? `${label}: ${value}` : label, ...qualifiers].join(" · ");
  });
}

/** Whether any rule of the situation is restriction evidence: shown, never routed. */
export function hasRestrictionEvidence(event: Pick<RoadConditionEvent, "effects">): boolean {
  return event.effects.some(isRestrictionEvidence);
}
