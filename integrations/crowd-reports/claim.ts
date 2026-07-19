import type { Fuzziness, ReportClaim } from "@openmapx/openconditions-contrib-client";

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
  "transit_disruption",
  "micromobility",
  "accessibility",
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

/**
 * The report domain a category belongs to. Transit disruptions ride the transit
 * graph, accessibility reports describe a place, everything else is a road
 * condition. Keeps the wire `domain` correct without the UI having to know it.
 */
const DOMAIN_BY_CATEGORY: Record<ReportCategory, ReportClaim["domain"]> = {
  road_closure: "roads",
  lane_closure: "roads",
  accident: "roads",
  stopped_vehicle: "roads",
  hazard_object: "roads",
  hazard_weather: "roads",
  hazard_animal: "roads",
  jam: "roads",
  roadworks: "roads",
  transit_disruption: "transit",
  micromobility: "roads",
  accessibility: "places",
  other: "roads",
};

/**
 * The CANONICAL taxonomy value each category reports as — `ReportClaim.type` is
 * a canonical value, not our dialog's vocabulary.
 *
 * This is what lets a crowd report be cross-validated: the evidence matcher
 * pairs a report with an official feed observation only when their `type` is
 * identical, and the feeds speak OpenConditions' road-event taxonomy
 * (`congestion`, `obstruction`, `hazard`, `weather`, …). Sending the raw UI
 * category meant "jam" could never meet the feeds' "congestion", so those
 * reports could never be confirmed by a feed and never became routing-eligible.
 *
 * Mappings follow what the feed normalizers actually emit, so a report lands on
 * the same value an official row would: an object on the road is DATEX
 * `generalobstruction` → `obstruction`, while animals are mapped to `hazard`
 * ("Animals on the road", "plant/animal hazards"), NOT `obstruction`. A stopped
 * vehicle is DATEX `vehicleObstruction` → `broken_down_vehicle` (distinct from a
 * generic object), and a partial closure is `lane_closure` (distinct from a full
 * `road_closure`) — both first-class canonical types the map already renders.
 *
 * `micromobility` and `accessibility` have no canonical road equivalent and
 * collapse to `other`; the dialog's own choice is preserved verbatim in
 * `attributes.reportCategory`, so nothing the user picked is lost.
 */
const TYPE_BY_CATEGORY: Record<ReportCategory, ReportClaim["type"]> = {
  road_closure: "road_closure",
  lane_closure: "lane_closure",
  accident: "accident",
  stopped_vehicle: "broken_down_vehicle",
  hazard_object: "obstruction",
  hazard_weather: "weather",
  hazard_animal: "hazard",
  jam: "congestion",
  roadworks: "roadworks",
  transit_disruption: "transit_disruption",
  micromobility: "other",
  accessibility: "other",
  other: "other",
};

/**
 * The severity (1–5) each category preselects when picked, so the common case is
 * one tap fewer — the reporter can still override it. Rough danger ordering:
 * a full closure or crash is high; a partial closure, stopped vehicle or hazard
 * is medium; congestion, roadworks and soft categories are low.
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
  transit_disruption: 2,
  micromobility: 2,
  accessibility: 2,
  other: 1,
};

export function fuzzinessForChoice(choice: FuzzinessChoice): Fuzziness {
  return FUZZINESS_BY_CHOICE[choice];
}

export function defaultSeverityForCategory(category: ReportCategory): 1 | 2 | 3 | 4 | 5 {
  return DEFAULT_SEVERITY_BY_CATEGORY[category];
}

export function domainForCategory(category: ReportCategory): ReportClaim["domain"] {
  return DOMAIN_BY_CATEGORY[category];
}

export function typeForCategory(category: ReportCategory): ReportClaim["type"] {
  return TYPE_BY_CATEGORY[category];
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
 * Build a signable {@link ReportClaim} from a dialog selection. Pure: the same
 * input (with an explicit `reportedAt`/`nonce`) always yields the same claim, so
 * it is unit-testable without mocking time or crypto. The geometry is always a
 * Point at the chosen location; the `fuzziness` communicates how far the
 * condition actually extends.
 */
export function buildReportClaim(input: BuildReportClaimInput): ReportClaim {
  const claim: ReportClaim = {
    domain: domainForCategory(input.category),
    type: typeForCategory(input.category),
    geometry: { type: "Point", coordinates: [input.lon, input.lat] },
    fuzziness: fuzzinessForChoice(input.fuzziness),
    // The canonical `type` is what the matcher pairs on, so several categories
    // share one value. Keep the exact choice the reporter made — it is the only
    // record of it once the type is canonicalized.
    attributes: { reportCategory: input.category },
    reportedAt: input.reportedAt ?? new Date().toISOString(),
    nonce: input.nonce ?? generateNonce(),
  };
  if (input.severityLevel !== undefined) claim.severityLevel = input.severityLevel;
  return claim;
}
