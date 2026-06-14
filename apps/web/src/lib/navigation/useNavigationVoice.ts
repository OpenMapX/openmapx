import { useCallback } from "react";
import { hasCapability } from "../platformCapabilities";

// Available TTS voices, cached at module scope. `getVoices()` is often empty on
// first call and populated later, so we also refresh on the `voiceschanged`
// event. Both are feature-detected so non-browser/test environments are safe.
let voicesCache: SpeechSynthesisVoice[] = [];
let voicesListenerAttached = false;

function ensureVoices(): void {
  const ss = window.speechSynthesis;
  if (typeof ss?.getVoices === "function") {
    const v = ss.getVoices();
    if (v && v.length > 0) voicesCache = v;
  }
  if (!voicesListenerAttached && typeof ss?.addEventListener === "function") {
    voicesListenerAttached = true;
    ss.addEventListener("voiceschanged", () => {
      const v = ss.getVoices?.();
      if (v && v.length > 0) voicesCache = v;
    });
  }
}

/** Best-matching installed voice for `locale` ("en-US" → an exact, then any en voice). */
function pickVoice(locale: string): SpeechSynthesisVoice | undefined {
  if (voicesCache.length === 0) return undefined;
  const wanted = locale.toLowerCase();
  const base = wanted.split("-")[0];
  return (
    voicesCache.find((v) => v.lang?.toLowerCase() === wanted) ??
    voicesCache.find((v) => v.lang?.toLowerCase().startsWith(base))
  );
}

/**
 * Prime SpeechSynthesis from a user gesture (the "Start" tap). iOS Safari keeps
 * TTS silent until the engine is first invoked inside a gesture; speaking a
 * short silent utterance unlocks it for the rest of the session. Best-effort
 * and a no-op when unsupported.
 */
export function primeSpeechSynthesis(): void {
  if (!hasCapability("speech")) return;
  try {
    ensureVoices();
    const u = new window.SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* priming is best-effort */
  }
}

/** Returns a `speak(text)` function backed by SpeechSynthesis (locale-aware). No-op when unsupported. */
export function useNavigationVoice(locale: string): (text: string) => void {
  return useCallback(
    (text: string) => {
      if (!hasCapability("speech")) return;
      ensureVoices();
      const u = new window.SpeechSynthesisUtterance(text);
      u.lang = locale;
      const voice = pickVoice(locale);
      if (voice) u.voice = voice;
      // Cancel any in-flight prompt so a fresh cue interrupts a stale one rather
      // than queueing behind it (queued prompts otherwise play late and pile up).
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    },
    [locale],
  );
}
