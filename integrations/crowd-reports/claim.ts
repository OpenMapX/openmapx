import type { Fuzziness, ReportClaim } from "@openmapx/openconditions-contrib-client";

/**
 * The crowd-report categories offered in the report dialog. `police` is
 * deliberately omitted — it is off by default per the OpenConditions ADR and is
 * gated behind a separate operator toggle (a later task), so it is not part of
 * this taxonomy.
 */
export const REPORT_CATEGORIES = [
  "road_closure",
  "accident",
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
  accident: "roads",
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

export function fuzzinessForChoice(choice: FuzzinessChoice): Fuzziness {
  return FUZZINESS_BY_CHOICE[choice];
}

export function domainForCategory(category: ReportCategory): ReportClaim["domain"] {
  return DOMAIN_BY_CATEGORY[category];
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
    type: input.category,
    geometry: { type: "Point", coordinates: [input.lon, input.lat] },
    fuzziness: fuzzinessForChoice(input.fuzziness),
    reportedAt: input.reportedAt ?? new Date().toISOString(),
    nonce: input.nonce ?? generateNonce(),
  };
  if (input.severityLevel !== undefined) claim.severityLevel = input.severityLevel;
  return claim;
}
