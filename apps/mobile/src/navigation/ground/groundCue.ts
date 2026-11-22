import {
  type CueReference,
  chooseReference,
  type GroundMobileSession,
  maneuverStartMeters,
  type Route,
  spokenInstructionFor,
  type VoiceCue,
} from "@openmapx/core/navigation";
import { formatNavigationCue } from "@openmapx/i18n";
import { MAX_CUE_ID_LENGTH, MAX_SPEECH_TEXT_LENGTH } from "../../audio/navigationAudio";
import type { SessionEffect } from "../../storage/SessionRepository";

/**
 * What the engine's abstract cue becomes: an identifier that survives a restart,
 * and one already-localised sentence.
 *
 * The identifier includes the route fingerprint, so replacing a route also
 * replaces the cue namespace. Without that, a reroute onto a new road could find
 * "turn left in 200 metres" already in the spoken ledger and stay silent at the
 * one turn the user did not expect.
 *
 * Localisation happens here, in TypeScript, against the same catalogs the web
 * app uses — not in Swift or Kotlin. Two implementations of the same sentence
 * would drift, and only one of them would have a translator.
 */

/** A cue whose moment has passed is not worth speaking late. */
export const MAX_CUE_AGE_MS = 10_000;

export function groundCueId(sessionId: string, routeFingerprint: string, cueKey: string): string {
  return `${sessionId}:ground:${routeFingerprint}:${cueKey}`.slice(0, MAX_CUE_ID_LENGTH);
}

export interface GroundCueEffect {
  cueId: string;
  effect: Extract<SessionEffect, { kind: "speak" }>;
}

/**
 * Builds the speak intent for one cue, or nothing when there is nothing to say.
 *
 * Returns the identifier even when speech is disabled, so the caller can still
 * record that the engine reached this cue — the ledger tracks *progression*,
 * not audio, and a session with voice off must not re-announce everything the
 * moment the user turns it back on.
 */
export function groundCueEffect(
  session: GroundMobileSession,
  routeFingerprint: string,
  cue: VoiceCue,
): GroundCueEffect | null {
  const instruction = spokenInstructionFor(cue);
  if (!instruction) return null;

  // The formatter refuses text beyond its own bounds. Losing one cue to a
  // malformed step is acceptable; losing the batch — and with it the user's
  // committed progress — is not, so the refusal becomes silence here.
  let text: string;
  try {
    const reference = packageReference(session, cue);
    text = formatNavigationCue(
      {
        kind: "ground-maneuver",
        tier: cue.tier,
        instruction,
        ...(cue.tier === "now" ? {} : { distanceMeters: cue.distance }),
        ...(reference && { reference }),
      },
      session.locale,
      { units: session.units },
    );
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;

  const cueId = groundCueId(session.sessionId, routeFingerprint, cue.key);
  return { cueId, effect: { kind: "speak", cueId, text, locale: session.locale } };
}

const REFERENCE_MODES: ReadonlySet<string> = new Set(["driving", "motorcycle"]);

/**
 * The traffic light or landmark a near cue may name, from the evidence the
 * start package carries for its route. Driving and motorcycle only; nothing
 * when the package carries none, so the prompt keeps its distance.
 */
function packageReference(session: GroundMobileSession, cue: VoiceCue): CueReference | null {
  const startPackage = session.payload.startPackage;
  if (cue.tier !== "near" || !REFERENCE_MODES.has(startPackage.mode)) return null;
  const route = startPackage.route as unknown as Route;
  const maneuverAlong = maneuverStartMeters(route, cue.stepIndex);
  return chooseReference({
    steps: route.steps,
    stepIndex: cue.stepIndex,
    maneuverAlong,
    puckAlong: maneuverAlong - cue.distance,
    signalsAlong: startPackage.signalsAlong ?? null,
    fetchedSpans: startPackage.signalSpans ?? [],
    landmark:
      startPackage.landmarkReferences?.find((entry) => entry.stepIndex === cue.stepIndex) ?? null,
  });
}

/** One warning per off-route episode, not one per fix at 1 Hz. */
export function offRouteEpisodeId(
  sessionId: string,
  routeFingerprint: string,
  episodeStartedAtMs: number,
): string {
  return groundCueId(sessionId, routeFingerprint, `off-route:${episodeStartedAtMs}`);
}

export function arrivalCueId(sessionId: string, routeFingerprint: string): string {
  return groundCueId(sessionId, routeFingerprint, "arrival");
}

/** The localised sentence for a status cue that has no maneuver behind it. */
export function statusCueEffect(
  session: GroundMobileSession,
  cueId: string,
  kind: "off-route" | "arrival" | "weak-gps",
): Extract<SessionEffect, { kind: "speak" }> | null {
  let text: string;
  try {
    text = formatNavigationCue({ kind }, session.locale, { units: session.units });
  } catch {
    return null;
  }
  if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;
  return { kind: "speak", cueId, text, locale: session.locale };
}
