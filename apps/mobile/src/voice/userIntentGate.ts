/**
 * Whether a `voice.start` from the page follows something the person did.
 *
 * The page is trusted first-party code, but a script injected into it could
 * otherwise start the microphone in a loop and read the transcripts. So the
 * shell starts listening only within a short window after a touch it observed
 * itself on the screen, and each touch admits one start. With a screen reader
 * on, activation arrives as an accessibility action rather than a touch, so the
 * touch requirement is waived there instead of locking those users out.
 */
export const USER_INTENT_WINDOW_MS = 3000;

export interface UserIntentGate {
  /** A touch began somewhere in the shell's view tree. */
  touched(): void;
  setScreenReader(enabled: boolean): void;
  /** True once per touch inside the window, or while a screen reader is on. */
  admit(): boolean;
}

export function createUserIntentGate(now: () => number = Date.now): UserIntentGate {
  let touchedAt: number | null = null;
  let screenReader = false;
  return {
    touched() {
      touchedAt = now();
    },
    setScreenReader(enabled) {
      screenReader = enabled;
    },
    admit() {
      if (screenReader) return true;
      const at = touchedAt;
      touchedAt = null;
      return at !== null && now() - at <= USER_INTENT_WINDOW_MS;
    },
  };
}
