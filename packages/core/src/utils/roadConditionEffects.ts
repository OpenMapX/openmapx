import { z } from "zod";
import type {
  LocalizedText,
  RoadConditionEvent,
  RoadConditionSchedule,
  RoadConditionValidity,
} from "../types/roadConditions";
import { localDateInZone, zonedWallClockToInstant } from "./wallClock";

/**
 * The host's mirror of the OpenConditions model `Effect`: what a situation
 * does to traffic, one typed rule per effect. The provider sends records 1:1;
 * this module validates each effect at the boundary and answers the questions
 * consumers ask of one — is it in force at an instant, which vehicles does it
 * bind, does it close the road for cars, what speed does it cap.
 *
 * Schemas are open (unknown keys are kept, not rejected) so a producer minor
 * version that adds a field still reads; a kind or field this host does not
 * know fails validation and the effect is replaced by an `unsupported` one,
 * which is restriction evidence: never routed, shown as unsupported.
 */

const TEXT_LIMIT = 4096;

const localizedText = z
  .array(z.object({ lang: z.string().min(1), text: z.string().max(TEXT_LIMIT) }))
  .min(1);
const quantity = z.object({ value: z.number(), unit: z.string().min(1) });

export const roadConditionScheduleSchema = z.object({
  repeatFrequency: z.string().optional(),
  repeatCount: z.number().int().positive().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  duration: z.string().optional(),
  byDay: z.array(z.string()).optional(),
  byMonth: z.array(z.number().int()).optional(),
  byMonthDay: z.array(z.number().int()).optional(),
  exceptDate: z.array(z.string()).optional(),
  scheduleTimezone: z.string().min(1),
});

export const roadConditionValiditySchema = z.object({
  status: z.enum(["planned", "active", "suspended", "ended", "cancelled", "unknown"]),
  start: z.string().optional(),
  end: z.string().optional(),
  estimatedEnd: z.string().optional(),
  periods: z.array(roadConditionScheduleSchema).min(1).optional(),
  exceptions: z.array(roadConditionScheduleSchema).min(1).optional(),
});

export const VEHICLE_CLASSES = [
  "motor_vehicle",
  "car",
  "van",
  "truck",
  "hgv",
  "bus",
  "coach",
  "motorcycle",
  "moped",
  "bicycle",
  "pedestrian",
  "trailer",
  "caravan",
  "agricultural",
  "emergency",
  "taxi",
  "oversize",
  "abnormal_load",
] as const;

const DIMENSIONS = [
  "height",
  "width",
  "length",
  "gross_weight",
  "laden_weight",
  "axle_load",
  "axle_count",
  "trailer_count",
] as const;

const vehicleSelector = z.object({
  class: z.enum(VEHICLE_CLASSES).optional(),
  usage: z.string().optional(),
  fuel: z.string().optional(),
  emission: z.object({ scheme: z.string(), values: z.array(z.string()) }).optional(),
  when: z
    .array(
      z.object({
        dimension: z.enum(DIMENSIONS),
        operator: z.enum(["lt", "lte", "eq", "gte", "gt"]),
        value: quantity,
      }),
    )
    .optional(),
  hazmat: z
    .object({
      adrTunnelCategory: z.string().optional(),
      unClasses: z.array(z.string()).optional(),
      placarded: z.boolean().optional(),
    })
    .optional(),
  hovMin: z.number().int().optional(),
  raw: z.array(z.string()).optional(),
});

/**
 * Which vehicles an effect binds. "all": every vehicle, minus `except`.
 * "classes": the vehicles `include` selects (selectors OR-ed, fields inside
 * one AND-ed), minus `except`. "unknown": the source restricts some vehicles
 * but did not say which.
 */
export const vehicleApplicabilitySchema = z.object({
  kind: z.enum(["all", "classes", "unknown"]),
  include: z.array(vehicleSelector).min(1).optional(),
  except: z.array(vehicleSelector).min(1).optional(),
  raw: z.array(z.string()).optional(),
});

const issue = z.object({
  code: z.string().min(1),
  sourcePath: z.string(),
  sourceText: z.string().max(TEXT_LIMIT).optional(),
});

const common = {
  id: z.string().min(1),
  v: z.number().int().positive(),
  sourceRecordRef: z.string().optional(),
  location: z
    .object({
      geometry: z.unknown().optional(),
      areaDescription: localizedText.optional(),
    })
    .optional(),
  applicability: vehicleApplicabilitySchema,
  direction: z
    .object({
      value: z.string(),
      basis: z.string().optional(),
      compass: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  laneScope: z.array(z.object({ index: z.number().int(), type: z.string().optional() })).optional(),
  validity: roadConditionValiditySchema.optional(),
  compliance: z.enum(["mandatory", "advisory", "unknown"]),
  normalization: z.enum(["complete", "partial", "unsupported"]),
  actionStatus: z.string().optional(),
  issues: z.array(issue).min(1).optional(),
};

const LANE_STATUSES = [
  "open",
  "closed",
  "alternating",
  "shift_left",
  "shift_right",
  "merge_left",
  "merge_right",
  "narrowed",
  "contraflow",
] as const;

export const roadConditionEffectSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("closure"),
    scope: z.enum([
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
    ]),
  }),
  z.object({
    ...common,
    kind: z.literal("lane_restriction"),
    lanesTotal: z.number().int().positive().optional(),
    lanesClosed: z.number().int().nonnegative().optional(),
    lanes: z
      .array(
        z.object({
          index: z.number().int(),
          type: z.string().optional(),
          status: z.enum(LANE_STATUSES),
        }),
      )
      .optional(),
    vehicleImpact: z.string().min(1),
  }),
  z.object({
    ...common,
    kind: z.literal("speed_limit"),
    limit: quantity,
    advisory: z.boolean().optional(),
    displayed: z.boolean().optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("delay"),
    delay: quantity.optional(),
    queueLength: quantity.optional(),
    los: z.string().optional(),
    capacityRemainingPct: z.number().min(0).max(100).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("access"),
    mode: z.string().min(1),
    chainLevel: z.enum(["R1", "R2", "R3"]).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("dimension_limit"),
    dimension: z.enum(DIMENSIONS),
    value: quantity,
    operator: z.enum(["lt", "lte"]),
    meaning: z.enum(["maximum_permitted", "physical_limit"]),
  }),
  z.object({
    ...common,
    kind: z.literal("hazmat"),
    mode: z.enum(["prohibited", "restricted"]),
    adrTunnelCategory: z.enum(["B", "C", "D", "E"]).optional(),
    unClasses: z.array(z.string()).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("detour"),
    description: localizedText.optional(),
    geometry: z.unknown().optional(),
    signed: z.boolean().optional(),
    via: z
      .array(z.object({ ref: z.string().optional(), name: localizedText.optional() }))
      .optional(),
  }),
  z.object({ ...common, kind: z.literal("contraflow") }),
  z.object({ ...common, kind: z.literal("advisory"), text: localizedText }),
  z.object({ ...common, kind: z.literal("unsupported"), summary: localizedText.optional() }),
]);

export type RoadConditionEffect = z.output<typeof roadConditionEffectSchema>;
export type VehicleApplicability = z.output<typeof vehicleApplicabilitySchema>;

/**
 * An effect the host could not read: kept as `unsupported` restriction
 * evidence, so a rule this host does not understand is never mistaken for
 * the absence of a rule.
 */
function unreadable(raw: unknown, index: number): RoadConditionEffect {
  const id =
    raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string"
      ? (raw as { id: string }).id
      : `effects[${index}]`;
  return {
    id,
    kind: "unsupported",
    v: 1,
    applicability: { kind: "unknown" },
    compliance: "unknown",
    normalization: "unsupported",
    issues: [{ code: "unsupported_type", sourcePath: `effects[${index}]` }],
  };
}

/** Validates a provider's effects; each one that does not read becomes `unsupported`. */
export function readRoadConditionEffects(raw: unknown): RoadConditionEffect[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((effect, i) => {
    const parsed = roadConditionEffectSchema.safeParse(effect);
    return parsed.success ? parsed.data : unreadable(effect, i);
  });
}

/**
 * Restriction evidence: a rule whose vehicles or meaning the source did not
 * fully give. It is shown, never routed, and never widened to all traffic.
 */
export function isRestrictionEvidence(effect: RoadConditionEffect): boolean {
  return effect.applicability.kind === "unknown" || effect.normalization !== "complete";
}

/** An effect that binds some vehicles only, or is a vehicle rule in itself. */
export function isVehicleSpecific(effect: RoadConditionEffect): boolean {
  return (
    effect.kind === "dimension_limit" ||
    effect.kind === "hazmat" ||
    effect.kind === "unsupported" ||
    effect.applicability.kind !== "all"
  );
}

const CAR_CLASSES = new Set(["car", "motor_vehicle"]);
const selectsCars = (selectors: VehicleApplicability["include"]) =>
  selectors?.some(
    (s) =>
      s.class !== undefined &&
      CAR_CLASSES.has(s.class) &&
      Object.keys(s).every((k) => k === "class" || k === "raw"),
  ) ?? false;
const excludesCars = (selectors: VehicleApplicability["except"]) =>
  selectors?.some((s) => s.class === undefined || CAR_CLASSES.has(s.class)) ?? false;

/**
 * Whether an effect binds every passenger car: all vehicles, or a class
 * selection naming cars unconditionally, and no exception that could spare a car.
 */
export function bindsEveryCar(applicability: VehicleApplicability): boolean {
  if (applicability.kind === "unknown") return false;
  if (excludesCars(applicability.except)) return false;
  return applicability.kind === "all" || selectsCars(applicability.include);
}

/** Closure scopes that close no part of the carriageway cars drive on. */
const NON_CARRIAGEWAY_SCOPES = new Set(["sidewalk", "cycleway", "rest_area", "facility"]);

/**
 * Whether an effect closes the road to passenger cars: a closure of a
 * carriageway element, or every lane closed, binding every car, fully read.
 */
export function closesRoadForCars(effect: RoadConditionEffect): boolean {
  if (isRestrictionEvidence(effect) || !bindsEveryCar(effect.applicability)) return false;
  if (effect.kind === "closure") return !NON_CARRIAGEWAY_SCOPES.has(effect.scope);
  return effect.kind === "lane_restriction" && effect.vehicleImpact === "all_lanes_closed";
}

/** The speed an effect caps every car to, in km/h; undefined when it caps none. */
export function speedCapKph(effect: RoadConditionEffect): number | undefined {
  if (effect.kind !== "speed_limit" || effect.advisory === true) return undefined;
  if (isRestrictionEvidence(effect) || !bindsEveryCar(effect.applicability)) return undefined;
  return effect.limit.unit === "km/h" ? effect.limit.value : undefined;
}

function parseHhMm(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const ICAL_DAY = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** iCal weekday code for a local "YYYY-MM-DD" date (UTC-parsed → calendar day). */
function iCalDayOf(localDate: string): string | undefined {
  const d = new Date(`${localDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : ICAL_DAY[d.getUTCDay()];
}

function addDaysLocal(localDate: string, delta: number): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 duration → milliseconds (PnDTnHnMnS subset). */
function durationToMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const m = iso.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return (
    (Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) *
    1_000
  );
}

/** Length of each occurrence: explicit `duration`, else endTime−startTime
 * (overnight-aware), else the whole day. */
function occurrenceDurationMs(schedule: RoadConditionSchedule): number {
  const explicit = durationToMs(schedule.duration);
  if (explicit != null) return explicit;
  const s = parseHhMm(schedule.startTime);
  const e = parseHhMm(schedule.endTime);
  if (s != null && e != null) {
    let mins = e - s;
    if (mins <= 0) mins += 24 * 60;
    return mins * 60_000;
  }
  return 24 * 3_600 * 1_000;
}

/** Whether the recurrence has an occurrence STARTING on local date `d`. */
function occurrenceStartsOn(schedule: RoadConditionSchedule, d: string): boolean {
  if (schedule.startDate && d < schedule.startDate.slice(0, 10)) return false;
  if (schedule.endDate && d > schedule.endDate.slice(0, 10)) return false;
  if (schedule.exceptDate?.some((x) => x.slice(0, 10) === d)) return false;
  if (schedule.byDay && schedule.byDay.length > 0) {
    const ical = iCalDayOf(d);
    if (!ical || !schedule.byDay.includes(ical)) return false;
  }
  return true;
}

/**
 * Whether the instant `at` falls inside an occurrence of a schema.org-shaped
 * `Schedule`, evaluated in the schedule's OWN `scheduleTimezone` (DST-correct).
 * Each occurrence starts at `startTime` (local) on a qualifying date and lasts
 * `occurrenceDurationMs`. The occurrence that could contain `at` starts on
 * `at`'s local date or up to its length in days before it (at most a year).
 */
export function scheduleOccursAt(schedule: RoadConditionSchedule, at: Date): boolean {
  const tz = schedule.scheduleTimezone;
  const startTime = schedule.startTime ?? "00:00";
  const durMs = occurrenceDurationMs(schedule);
  const atLocalDate = localDateInZone(at, tz);
  // An occurrence longer than a day can have started that many days back, as
  // a one-off period OpenConditions writes as one start day and its duration.
  const lookbackDays = Math.min(366, Math.max(1, Math.ceil(durMs / 86_400_000)));
  for (let back = 0; back <= lookbackDays; back++) {
    const startDate = addDaysLocal(atLocalDate, -back);
    if (!occurrenceStartsOn(schedule, startDate)) continue;
    const start = zonedWallClockToInstant(tz, `${startDate}T${startTime}`);
    if (!start) continue;
    const startMs = start.getTime();
    if (at.getTime() >= startMs && at.getTime() < startMs + durMs) return true;
  }
  return false;
}

/**
 * Whether a validity holds at `at`: not ended or cancelled, inside its
 * declared bounds (each inclusive, unbounded when absent), inside one of its
 * periods when it has any, and inside none of its exceptions.
 */
export function validityHoldsAt(validity: RoadConditionValidity, at: Date): boolean {
  if (validity.status === "ended" || validity.status === "cancelled") return false;
  const t = at.getTime();
  if (validity.start && t < Date.parse(validity.start)) return false;
  if (validity.end && t > Date.parse(validity.end)) return false;
  if (validity.periods && !validity.periods.some((p) => scheduleOccursAt(p, at))) return false;
  return !validity.exceptions?.some((p) => scheduleOccursAt(p, at));
}

/** The validity an effect is evaluated against: its own, else its situation's. */
export function effectValidity(
  event: Pick<RoadConditionEvent, "validity">,
  effect: RoadConditionEffect,
): RoadConditionValidity {
  return effect.validity ?? event.validity;
}

/** Whether an effect of `event` is in force at `at`. */
export function effectInForceAt(
  event: Pick<RoadConditionEvent, "validity">,
  effect: RoadConditionEffect,
  at: Date,
): boolean {
  return validityHoldsAt(effectValidity(event, effect), at);
}

/**
 * The text to show for `locale`: the entry in that language, else in its
 * base language, else the publisher's own (the first).
 */
export function localizedTextFor(
  text: LocalizedText | undefined,
  locale: string,
): string | undefined {
  if (!text?.length) return undefined;
  const lang = locale.toLowerCase();
  const base = lang.split("-")[0];
  return (
    text.find((t) => t.lang.toLowerCase() === lang)?.text ??
    text.find((t) => t.lang.toLowerCase().split("-")[0] === base)?.text ??
    text[0]!.text
  );
}
