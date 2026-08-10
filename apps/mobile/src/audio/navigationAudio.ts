import type { MobileLocale } from "../../config/nativeCopy";

/**
 * The typed boundary in front of the project-owned speech module.
 *
 * The native side receives already-localised text and a stable cue ID and
 * nothing else. It cannot fetch a URL, read a file, read location, or raise an
 * arbitrary notification. All wording decisions stay in shared TypeScript, so
 * the Swift and Kotlin surface remains small enough to review.
 *
 * Validation happens here rather than natively so a malformed request fails the
 * same way on both platforms.
 */

export interface SpeakRequest {
  cueId: string;
  text: string;
  locale: MobileLocale;
  /** Speech rate multiplier; the platform default is used when omitted. */
  rate?: number;
}

export type SpeakResult = "spoken" | "skipped" | "failed";

export interface NavigationAudioStatus {
  initialized: boolean;
  speaking: boolean;
  localeAvailable: boolean;
  lastResultCode: string | null;
}

/** The surface the native module must implement. */
export interface NativeNavigationAudio {
  speak(request: SpeakRequest): Promise<SpeakResult>;
  stop(): Promise<void>;
  getStatus?(): Promise<NavigationAudioStatus>;
}

export interface NavigationAudio {
  speak(request: SpeakRequest): Promise<SpeakResult>;
  stop(): Promise<void>;
  getStatus(): Promise<NavigationAudioStatus>;
}

export const MAX_CUE_ID_LENGTH = 128;
export const MAX_SPEECH_TEXT_LENGTH = 512;
export const MIN_SPEECH_RATE = 0.5;
export const MAX_SPEECH_RATE = 2.0;

const SUPPORTED_LOCALES: readonly MobileLocale[] = ["en", "de"];

export class NavigationAudioRequestError extends Error {}

/**
 * Rejects C0 control characters and DEL, which either read aloud as noise or
 * truncate the utterance depending on the platform synthesiser. A newline is
 * allowed because cues legitimately join two sentences.
 *
 * Written as a code-point scan rather than a regular expression so the rule is
 * readable and identical to `NavigationAudioPolicy.swift` and
 * `NavigationAudioPolicy.kt`, which enforce it again on the native side.
 */
export function containsDisallowedControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Throws for anything outside the bounded contract. Never mutates the input. */
export function validateSpeakRequest(request: SpeakRequest): SpeakRequest {
  if (!request || typeof request !== "object") {
    throw new NavigationAudioRequestError("speak requires a request object");
  }
  const { cueId, text, locale, rate } = request;
  if (typeof cueId !== "string" || cueId.length === 0 || cueId.length > MAX_CUE_ID_LENGTH) {
    throw new NavigationAudioRequestError("cueId must be 1 to 128 characters");
  }
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_SPEECH_TEXT_LENGTH) {
    throw new NavigationAudioRequestError("text must be 1 to 512 characters");
  }
  if (containsDisallowedControlCharacter(text)) {
    throw new NavigationAudioRequestError("text must not contain control characters");
  }
  if (!SUPPORTED_LOCALES.includes(locale)) {
    throw new NavigationAudioRequestError("locale must be en or de");
  }
  if (rate !== undefined) {
    if (!Number.isFinite(rate) || rate < MIN_SPEECH_RATE || rate > MAX_SPEECH_RATE) {
      throw new NavigationAudioRequestError("rate must be between 0.5 and 2.0");
    }
  }
  return rate === undefined ? { cueId, text, locale } : { cueId, text, locale, rate };
}

/**
 * Wraps a native implementation with validation and error mapping. A native
 * exception becomes `"failed"` so a synthesiser problem can never abort a
 * navigation tick — progress and persistence already committed before this ran.
 */
export function createNavigationAudio(native: NativeNavigationAudio): NavigationAudio {
  return {
    async speak(request) {
      const validated = validateSpeakRequest(request);
      try {
        const result = await native.speak(validated);
        return result === "spoken" || result === "skipped" ? result : "failed";
      } catch {
        return "failed";
      }
    },
    async stop() {
      try {
        await native.stop();
      } catch {
        // Releasing audio focus is best-effort; a failure here must not block
        // the rest of session teardown.
      }
    },
    async getStatus() {
      try {
        return (
          (await native.getStatus?.()) ?? {
            initialized: false,
            speaking: false,
            localeAvailable: false,
            lastResultCode: null,
          }
        );
      } catch {
        return {
          initialized: false,
          speaking: false,
          localeAvailable: false,
          lastResultCode: "status-unavailable",
        };
      }
    },
  };
}
