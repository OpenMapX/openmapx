import type { GroundMobileSession, VoiceCue } from "@openmapx/core/navigation";
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

/**
 * Picks the sentence to speak.
 *
 * Matches the browser's order exactly, because a user who switches between the
 * installed app and the site must not hear a different phrasing for the same
 * turn. Far and near cues carry the distance; the imminent one does not,
 * because by then the turn is right there.
 */
export function spokenInstructionFor(cue: VoiceCue): string | null {
  const step = cue.step as unknown as Record<string, unknown>;
  const candidates =
    cue.tier === "now"
      ? [step.verbalAlert, step.verbalPre, step.instruction]
      : [step.verbalSuccinct, step.verbalPre, step.instruction];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
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

  const text = formatNavigationCue(
    {
      kind: "ground-maneuver",
      tier: cue.tier,
      instruction,
      ...(cue.tier === "now" ? {} : { distanceMeters: cue.distance }),
    },
    session.locale,
    { units: session.units },
  );
  if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;

  const cueId = groundCueId(session.sessionId, routeFingerprint, cue.key);
  return { cueId, effect: { kind: "speak", cueId, text, locale: session.locale } };
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
  const text = formatNavigationCue({ kind }, session.locale, { units: session.units });
  if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;
  return { kind: "speak", cueId, text, locale: session.locale };
}
