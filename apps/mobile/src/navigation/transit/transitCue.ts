import type { TransitMobileSession, TransitNavigationEvent } from "@openmapx/core/navigation";
import { formatNavigationCue } from "@openmapx/i18n";
import { MAX_CUE_ID_LENGTH, MAX_SPEECH_TEXT_LENGTH } from "../../audio/navigationAudio";
import type { SessionEffect } from "../../storage/SessionRepository";

/**
 * What the engine's events become: an identifier that survives a restart, and
 * one already-localised sentence.
 *
 * The mapping is a closed switch over the engine's own event union, and every
 * name it speaks comes from the *validated captured itinerary* — never from a
 * bridge command. A page that could hand this module arbitrary text would be a
 * page that could make the app say anything, in the user's ear, while they are
 * driving or on a platform.
 *
 * Feed-supplied text gets the same treatment as any other untrusted input:
 * bounded, control characters stripped, and only ever tied to an alert already
 * attached to the active itinerary.
 */

/** Long enough for a real line, destination or stop name. */
const MAX_NAME_LENGTH = 120;
/** Feed alert text ceiling, matching the shared formatter's own bound. */
export const MAX_ALERT_TEXT_LENGTH = 240;

export function transitCueId(
  sessionId: string,
  itineraryFingerprint: string,
  eventId: string,
): string {
  return `${sessionId}:transit:${itineraryFingerprint}:${eventId}`.slice(0, MAX_CUE_ID_LENGTH);
}

/** C0 controls, DEL, and the two Unicode line/paragraph separators. */
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || code === 0x7f || code === 0x2028 || code === 0x2029;
}

/**
 * Cleans a name that came from a feed.
 *
 * Control characters are removed rather than escaped: a synthesiser reading a
 * line separator produces nothing useful, and leaving them in only widens what
 * a malformed feed can do.
 */
export function boundedName(value: unknown, limit = MAX_NAME_LENGTH): string | null {
  if (typeof value !== "string") return null;

  // A codepoint filter rather than a regular expression: what counts as a
  // control character is the point of this function, and spelling it out is
  // clearer than an escape range — and keeps literal control bytes out of the
  // source file.
  let cleaned = "";
  for (const character of value) {
    cleaned += isControlCodePoint(character.codePointAt(0) ?? 0) ? " " : character;
  }
  // Collapse the runs those substitutions create, so a name with an embedded
  // newline does not gain a double space when spoken.
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (cleaned.length === 0 || cleaned.length > limit) return null;
  return cleaned;
}

interface LegLike {
  route?: { shortName?: string; longName?: string };
  headsign?: string;
  from?: { name?: string; platformCode?: string };
  to?: { name?: string; platformCode?: string };
}

function legAt(session: TransitMobileSession, index: number): LegLike | undefined {
  const legs = (session.payload.startPackage.itinerary as { legs?: LegLike[] }).legs;
  return legs?.[index];
}

function lineName(leg: LegLike | undefined): string | null {
  return boundedName(leg?.route?.shortName ?? leg?.route?.longName);
}

export interface TransitCueEffect {
  cueId: string;
  critical: boolean;
  effect: Extract<SessionEffect, { kind: "speak" }>;
}

/**
 * Maps one engine event to a spoken cue, or to nothing.
 *
 * Returning nothing is a normal outcome: an event whose names the feed did not
 * supply is still a real event worth persisting and publishing, it simply has no
 * sentence. Silence is better than "board the".
 */
export function transitCueEffect(
  session: TransitMobileSession,
  event: TransitNavigationEvent,
): TransitCueEffect | null {
  const fingerprint = session.payload.startPackage.itineraryFingerprint;
  const cueId = transitCueId(session.sessionId, fingerprint, event.id);
  const locale = session.locale;
  const units = session.units;

  const speak = (
    intent: Parameters<typeof formatNavigationCue>[0],
    critical: boolean,
  ): TransitCueEffect | null => {
    let text: string;
    try {
      text = formatNavigationCue(intent, locale, { units });
    } catch {
      // A malformed name costs one announcement, never the committed batch.
      return null;
    }
    if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;
    return { cueId, critical, effect: { kind: "speak", cueId, text, locale } };
  };

  switch (event.type) {
    case "board": {
      const leg = legAt(session, event.legIndex);
      const line = lineName(leg);
      const destination = boundedName(leg?.headsign ?? leg?.to?.name);
      if (!line || !destination) return null;
      const platform = boundedName(leg?.from?.platformCode, 64);
      return speak({ kind: "board", line, destination, ...(platform ? { platform } : {}) }, true);
    }

    case "platform-change": {
      const platform = boundedName(event.platform, 64);
      if (!platform) return null;
      return speak({ kind: "platform-change", platform }, true);
    }

    case "approaching-alight":
    case "alight": {
      const stop = boundedName(legAt(session, event.legIndex)?.to?.name);
      if (!stop) return null;
      // Getting off is the one thing a rider cannot recover from missing.
      return speak({ kind: "alight", stop }, true);
    }

    case "transfer": {
      const from = legAt(session, event.fromLegIndex);
      const onto = legAt(session, event.toLegIndex);
      const stop = boundedName(from?.to?.name);
      const line = lineName(onto);
      if (!stop || !line) return null;
      return speak({ kind: "transfer", stop, line }, true);
    }

    case "missed-connection":
      return speak({ kind: "schedule-fallback" }, true);

    case "arrival":
      return speak({ kind: "arrival" }, true);
  }
}

/**
 * The cue for a walking instruction inside a walking leg.
 *
 * Separate from the event mapping because walking guidance is continuous rather
 * than event-driven; the engine reports which step, and the shared walk mapper
 * turns it into a sentence.
 */
export function transitWalkCueEffect(
  session: TransitMobileSession,
  cueKey: string,
  action: string,
  street?: string,
): TransitCueEffect | null {
  const boundedAction = boundedName(action);
  if (!boundedAction) return null;
  const boundedStreet = street === undefined ? undefined : boundedName(street);

  const cueId = transitCueId(
    session.sessionId,
    session.payload.startPackage.itineraryFingerprint,
    cueKey,
  );
  try {
    const text = formatNavigationCue(
      {
        kind: "walk",
        action: boundedAction,
        ...(boundedStreet ? { street: boundedStreet } : {}),
      },
      session.locale,
      { units: session.units },
    );
    if (text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) return null;
    return {
      cueId,
      critical: false,
      effect: { kind: "speak", cueId, text, locale: session.locale },
    };
  } catch {
    return null;
  }
}

/**
 * Whether a feed alert may be spoken at all.
 *
 * Only an alert attached to the active itinerary, only at the top severities,
 * and only its short text. A description or a URL is never read aloud: it is
 * arbitrary length, arbitrary content, and often HTML.
 */
export function speakableAlertText(alert: {
  id?: unknown;
  severity?: unknown;
  header?: unknown;
}): string | null {
  if (typeof alert.id !== "string" || alert.id.length === 0) return null;
  if (alert.severity !== "critical" && alert.severity !== "severe") return null;
  return boundedName(alert.header, MAX_ALERT_TEXT_LENGTH);
}
