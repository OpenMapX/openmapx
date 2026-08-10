import { useSettingsStore } from "@openmapx/core";
import { useCallback, useEffect, useState } from "react";
import { shellFeatureBoundary } from "../mobile/mobileShellEnvironment";
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

/**
 * Choose a voice: the one the user picked by name if still present, otherwise the
 * best match for `locale` (exact "en-US", then any "en"). Pure, so it's unit-
 * tested independently of the SpeechSynthesis engine.
 */
export function selectVoice<T extends { name: string; lang: string }>(
  voices: readonly T[],
  locale: string,
  preferredName?: string | null,
): T | undefined {
  if (voices.length === 0) return undefined;
  if (preferredName) {
    const named = voices.find((v) => v.name === preferredName);
    if (named) return named;
  }
  const wanted = locale.toLowerCase();
  const base = wanted.split("-")[0];
  return (
    voices.find((v) => v.lang?.toLowerCase() === wanted) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith(base))
  );
}

/** The installed TTS voices (refreshed via `voiceschanged`); for the settings picker. */
export function getAvailableVoices(): SpeechSynthesisVoice[] {
  ensureVoices();
  return voicesCache;
}

/** Reactive list of installed voices — updates when the engine populates them late. */
export function useAvailableVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => getAvailableVoices());
  useEffect(() => {
    const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!ss?.addEventListener) return;
    const onChange = () => setVoices([...getAvailableVoices()]);
    ss.addEventListener("voiceschanged", onChange);
    // Some browsers populate voices shortly after load without firing the event.
    const id = window.setTimeout(onChange, 300);
    return () => {
      ss.removeEventListener("voiceschanged", onChange);
      window.clearTimeout(id);
    };
  }, []);
  return voices;
}

/** Speak `text` once, interrupting any in-flight prompt. No-op when unsupported. */
export function speakOnce(text: string, locale: string, preferredName?: string | null): void {
  if (!shellFeatureBoundary().browserSpeech) return;
  if (!hasCapability("speech")) return;
  ensureVoices();
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = locale;
  const voice = selectVoice(voicesCache, locale, preferredName);
  if (voice) u.voice = voice;
  // Cancel any in-flight prompt so a fresh cue interrupts a stale one rather than
  // queueing behind it (queued prompts otherwise play late and pile up).
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

/**
 * Prime SpeechSynthesis from a user gesture (the "Start" tap). iOS Safari keeps
 * TTS silent until the engine is first invoked inside a gesture; speaking a
 * short silent utterance unlocks it for the rest of the session. Best-effort
 * and a no-op when unsupported.
 */
export function primeSpeechSynthesis(): void {
  // Native owns the voice inside the shell, where it can also speak with the
  // screen off. Two speakers would talk over each other.
  if (!shellFeatureBoundary().browserSpeech) return;
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

/** Returns a `speak(text)` function backed by SpeechSynthesis (locale- and voice-aware). */
export function useNavigationVoice(locale: string): (text: string) => void {
  const voiceName = useSettingsStore((s) => s.voiceName);
  return useCallback((text: string) => speakOnce(text, locale, voiceName), [locale, voiceName]);
}
