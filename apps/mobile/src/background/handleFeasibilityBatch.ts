import type { MobileLocale } from "../../config/nativeCopy";
import type { LocationFix } from "../location/LocationDriver";
import { accuracyBucket, type FeasibilityProbeState } from "../storage/feasibilityRepository";

/**
 * The body of the global TaskManager callback, extracted so it can be driven
 * deterministically by tests — including the ordering, duplication and process-
 * recreation cases a real device would take hours to reproduce.
 *
 * Contract:
 *   - the batch is sanitised (sorted, deduplicated, structurally validated)
 *     before anything is written;
 *   - exactly one transaction commits per callback;
 *   - side effects are *returned*, never performed here, so they always happen
 *     after the commit;
 *   - nothing rejects, because a throwing OS task callback can spin.
 */

/** Shape of `expo-location`'s task payload, narrowed to what the probe reads. */
export interface RawLocation {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy?: number | null;
    speed?: number | null;
    heading?: number | null;
    altitude?: number | null;
  };
}

export interface FeasibilityBatchInput {
  locations: readonly RawLocation[];
  errorCode?: string;
}

export interface FeasibilityRepositoryPort {
  read(): Promise<FeasibilityProbeState>;
  commit(
    mutate: (current: FeasibilityProbeState) => FeasibilityProbeState,
  ): Promise<FeasibilityProbeState>;
}

export interface FeasibilityBatchDeps {
  repository: FeasibilityRepositoryPort;
  nowMs: number;
  locale?: MobileLocale;
}

export type FeasibilityEffect = {
  kind: "speak";
  cueId: string;
  text: string;
  locale: MobileLocale;
};

/** A fix older than this relative to now is treated as a replayed artefact. */
export const MAX_FIX_AGE_MS = 5 * 60_000;
/** Tolerated forward clock skew between the OS fix clock and `Date.now()`. */
export const MAX_FIX_SKEW_MS = 2 * 60_000;
const MAX_ERROR_CODE_LENGTH = 64;

/** The one sentence the probe speaks, kept short and location-free by design. */
const PROBE_UTTERANCE: Record<MobileLocale, string> = {
  en: "OpenMapX background check.",
  de: "OpenMapX-Hintergrundprüfung.",
};

function toFix(raw: RawLocation, nowMs: number): LocationFix | null {
  if (!raw || typeof raw !== "object") return null;
  const { timestamp, coords } = raw;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (timestamp < nowMs - MAX_FIX_AGE_MS) return null;
  if (timestamp > nowMs + MAX_FIX_SKEW_MS) return null;
  if (!coords || typeof coords !== "object") return null;

  const { latitude, longitude, accuracy } = coords;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  // A fix without a usable accuracy cannot be judged against the engine's
  // accuracy cap later, so it is refused rather than assumed good.
  if (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0) return null;

  return {
    coords: [longitude, latitude],
    accuracy,
    timestampMs: timestamp,
    ...(typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0
      ? { speedMps: coords.speed }
      : {}),
    ...(typeof coords.heading === "number" && Number.isFinite(coords.heading)
      ? { headingDegrees: coords.heading }
      : {}),
  };
}

export interface SanitisedBatch {
  accepted: LocationFix[];
  rejectedCount: number;
}

/**
 * Sorts by timestamp, removes duplicates, drops structurally invalid or
 * implausible fixes, and keeps only fixes strictly newer than the last one
 * already persisted.
 */
export function sanitiseBatch(
  locations: readonly RawLocation[],
  nowMs: number,
  lastAcceptedTimestampMs: number | null,
): SanitisedBatch {
  const accepted: LocationFix[] = [];
  let rejectedCount = 0;

  const candidates: LocationFix[] = [];
  for (const raw of locations) {
    const fix = toFix(raw, nowMs);
    if (fix) candidates.push(fix);
    else rejectedCount += 1;
  }
  candidates.sort((a, b) => a.timestampMs - b.timestampMs);

  let watermark = lastAcceptedTimestampMs ?? Number.NEGATIVE_INFINITY;
  for (const fix of candidates) {
    // Equal timestamps are duplicates of the same instant, not new information.
    if (fix.timestampMs <= watermark) continue;
    watermark = fix.timestampMs;
    accepted.push(fix);
  }
  return { accepted, rejectedCount };
}

export async function handleFeasibilityBatch(
  input: FeasibilityBatchInput,
  deps: FeasibilityBatchDeps,
): Promise<FeasibilityEffect[]> {
  const { repository, nowMs } = deps;
  const locale = deps.locale ?? "en";
  try {
    const previous = await repository.read();
    const { accepted, rejectedCount } = sanitiseBatch(
      input.locations ?? [],
      nowMs,
      previous.lastTimestampMs,
    );
    const newest = accepted.at(-1);
    const gapMs = previous.updatedAtMs > 0 ? nowMs - previous.updatedAtMs : null;
    const shouldSpeak = previous.pendingAudioProbe && accepted.length > 0;

    const committed = await repository.commit((current) => ({
      ...current,
      callbackCount: current.callbackCount + 1,
      acceptedFixCount: current.acceptedFixCount + accepted.length,
      rejectedFixCount: current.rejectedFixCount + rejectedCount,
      lastTimestampMs: newest ? newest.timestampMs : current.lastTimestampMs,
      lastAccuracyBucket: newest ? accuracyBucket(newest.accuracy) : current.lastAccuracyBucket,
      lastCallbackGapMs: gapMs,
      maxCallbackGapMs:
        gapMs === null ? current.maxCallbackGapMs : Math.max(current.maxCallbackGapMs ?? 0, gapMs),
      lastErrorCode: input.errorCode
        ? input.errorCode.slice(0, MAX_ERROR_CODE_LENGTH)
        : current.lastErrorCode,
      // Cleared in the same transaction as the counters. If the process dies
      // before the prompt is spoken the cue is lost, never repeated.
      pendingAudioProbe: shouldSpeak ? false : current.pendingAudioProbe,
      updatedAtMs: nowMs,
    }));

    if (!shouldSpeak) return [];
    return [
      {
        kind: "speak",
        cueId: `probe:${committed.callbackCount}`,
        text: PROBE_UTTERANCE[locale],
        locale,
      },
    ];
  } catch {
    // The OS retries a failing background task aggressively. Swallowing here
    // keeps a broken database from turning into a wake-up loop; the failure is
    // visible as a stalled callback counter.
    return [];
  }
}
