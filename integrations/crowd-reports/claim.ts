import type { Effect, Fuzziness, SituationClaim } from "@openmapx/openconditions-contrib-client";

/**
 * The crowd-report categories offered in the report dialog. `police` is
 * deliberately omitted — it is off by default per the OpenConditions ADR and is
 * gated behind a separate operator toggle (a later task), so it is not part of
 * this taxonomy.
 */
export const REPORT_CATEGORIES = [
  "road_closure",
  "lane_closure",
  "accident",
  "stopped_vehicle",
  "hazard_object",
  "hazard_weather",
  "hazard_animal",
  "jam",
  "roadworks",
  "other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * The four fuzziness choices the picker offers, mapped to the wire `Fuzziness`
 * values understood by the contributions-api:
 *   here          → exact           ("it's right here")
 *   ahead         → end_unknown     ("somewhere ahead", far end unknown)
 *   back_of_queue → start_unknown   ("back of the queue", near end unknown)
 *   all_along     → extent_unknown  ("all along here", both ends unknown)
 */
export type FuzzinessChoice = "here" | "ahead" | "back_of_queue" | "all_along";

const FUZZINESS_BY_CHOICE: Record<FuzzinessChoice, Fuzziness> = {
  here: "exact",
  ahead: "end_unknown",
  back_of_queue: "start_unknown",
  all_along: "extent_unknown",
};

/** What a category reports as: the registered situation kind, type and subtype, plus its effects and details. */
export type CategorySituation = Pick<
  SituationClaim,
  "kind" | "type" | "subtype" | "effects" | "details"
>;

/**
 * The members every crowd effect shares: a reporter sees the situation apply to
 * everyone, as a fact on the road, fully expressed by the effect.
 */
function crowdEffect(id: string, kind: string, fields: Record<string, unknown>): Effect {
  return {
    id,
    kind,
    v: 1,
    applicability: { kind: "all" },
    compliance: "mandatory",
    normalization: "complete",
    ...fields,
  };
}

/**
 * The situation each category reports as, in the OpenConditions registry's
 * vocabulary — not our dialog's. A report is cross-validated against official
 * feeds by its kind and type, so a category lands on the same kind an official
 * record of the same thing would: an object on the road is an obstruction, a
 * stopped vehicle a breakdown, a queue a congestion with its level of service.
 * A full closure closes the road; a partial closure restricts some lanes and is
 * never a closure effect. Returns a fresh object per call.
 */
export function situationForCategory(category: ReportCategory): CategorySituation {
  switch (category) {
    case "road_closure":
      return {
        kind: "closure",
        type: "closure",
        subtype: "full",
        effects: [crowdEffect("closure", "closure", { scope: "road" })],
      };
    case "lane_closure":
      return {
        kind: "closure",
        type: "closure",
        subtype: "lane",
        effects: [crowdEffect("lanes", "lane_restriction", { vehicleImpact: "some_lanes_closed" })],
      };
    case "accident":
      return { kind: "incident", type: "accident" };
    case "stopped_vehicle":
      return { kind: "incident", type: "breakdown", subtype: "disabled_vehicle" };
    case "hazard_object":
      return { kind: "incident", type: "obstruction", subtype: "object" };
    case "hazard_weather":
      return { kind: "weather_condition", type: "weather" };
    case "hazard_animal":
      return { kind: "incident", type: "obstruction", subtype: "animal" };
    case "jam":
      return {
        kind: "congestion",
        type: "congestion",
        subtype: "queuing",
        details: { kind: "congestion", v: 1, los: "queuing" },
      };
    case "roadworks":
      return { kind: "roadworks", type: "works" };
    case "other":
      return { kind: "other", type: "other" };
  }
}

/**
 * The severity (1–5) each category preselects when picked, so the common case is
 * one tap fewer — the reporter can still override it. Rough danger ordering:
 * a full closure or crash is high; a partial closure, stopped vehicle or hazard
 * is medium; congestion and roadworks are low.
 */
const DEFAULT_SEVERITY_BY_CATEGORY: Record<ReportCategory, 1 | 2 | 3 | 4 | 5> = {
  road_closure: 5,
  lane_closure: 3,
  accident: 4,
  stopped_vehicle: 3,
  hazard_object: 3,
  hazard_weather: 3,
  hazard_animal: 3,
  jam: 2,
  roadworks: 2,
  other: 1,
};

export function fuzzinessForChoice(choice: FuzzinessChoice): Fuzziness {
  return FUZZINESS_BY_CHOICE[choice];
}

export function defaultSeverityForCategory(category: ReportCategory): 1 | 2 | 3 | 4 | 5 {
  return DEFAULT_SEVERITY_BY_CATEGORY[category];
}

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A random nonce that satisfies the wire contract (16..64 chars of
 * `[A-Za-z0-9_-]`). Uses platform CSPRNG; defaults to 24 chars.
 */
export function generateNonce(length = 24): string {
  const n = Math.min(64, Math.max(16, length));
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += NONCE_ALPHABET[b % NONCE_ALPHABET.length];
  }
  return out;
}

export interface BuildReportClaimInput {
  category: ReportCategory;
  fuzziness: FuzzinessChoice;
  /** WGS84 longitude of the reported condition. */
  lon: number;
  /** WGS84 latitude of the reported condition. */
  lat: number;
  severityLevel?: 1 | 2 | 3 | 4 | 5;
  /** ISO-8601 instant; defaults to now. */
  reportedAt?: string;
  /** Explicit nonce (tests); defaults to a fresh random one. */
  nonce?: string;
}

/**
 * Build a signable {@link SituationClaim} from a dialog selection. Pure: the
 * same input (with an explicit `reportedAt`/`nonce`) always yields the same
 * claim, so it is unit-testable without mocking time or crypto. The geometry is
 * always a Point at the chosen location; the `fuzziness` communicates how far
 * the situation actually extends.
 */
export function buildReportClaim(input: BuildReportClaimInput): SituationClaim {
  const { kind, type, subtype, effects, details } = situationForCategory(input.category);
  const claim: SituationClaim = {
    claimClass: "situation",
    kind,
    type,
    geometry: { type: "Point", coordinates: [input.lon, input.lat] },
    fuzziness: fuzzinessForChoice(input.fuzziness),
    reportedAt: input.reportedAt ?? new Date().toISOString(),
    nonce: input.nonce ?? generateNonce(),
  };
  if (subtype !== undefined) claim.subtype = subtype;
  if (input.severityLevel !== undefined) claim.severityLevel = input.severityLevel;
  if (effects !== undefined) claim.effects = effects;
  if (details !== undefined) claim.details = details;
  return claim;
}
