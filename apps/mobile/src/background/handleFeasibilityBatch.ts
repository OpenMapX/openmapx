import type { MobileLocale } from "../../config/nativeCopy";
import type { LocationFix } from "../location/LocationDriver";
import { type RawLocation, sanitiseRawLocations } from "../location/rawLocation";
import { accuracyBucket, type FeasibilityProbeState } from "../storage/feasibilityRepository";

export type { RawLocation } from "../location/rawLocation";
export { MAX_FIX_AGE_MS, MAX_FIX_SKEW_MS } from "../location/rawLocation";

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

const MAX_ERROR_CODE_LENGTH = 64;

/** The one sentence the probe speaks, kept short and location-free by design. */
const PROBE_UTTERANCE: Record<MobileLocale, string> = {
  en: "OpenMapX background check.",
  de: "OpenMapX-Hintergrundprüfung.",
};

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
  const batch = sanitiseRawLocations(locations, nowMs, lastAcceptedTimestampMs);
  const accepted: LocationFix[] = batch.accepted;
  return { accepted, rejectedCount: batch.rejectedCount };
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
