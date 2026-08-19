"use client";

import MicIcon from "@mui/icons-material/Mic";
import Alert from "@mui/material/Alert";
import IconButton from "@mui/material/IconButton";
import Snackbar from "@mui/material/Snackbar";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { shellFeatureBoundary } from "@/lib/mobile/mobileShellEnvironment";
import { useHydrated } from "@/lib/useHydrated";

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Browser SpeechRecognition constructor, if available (incl. the webkit prefix). */
function getSpeechRecognition(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Resolve a region-qualified BCP-47 tag for recognition. Android's speech
 * service rejects region-less tags (next-intl exposes `"en"`/`"de"`) with a
 * `language-not-supported` error, so prefer the device's own fully-qualified
 * language when it matches the app locale, then fall back to a default region.
 */
function speechLang(locale: string): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  if (nav.includes("-") && nav.split("-")[0].toLowerCase() === locale.toLowerCase()) {
    return nav;
  }
  const fallback: Record<string, string> = { en: "en-US", de: "de-DE" };
  return fallback[locale] ?? locale;
}

/**
 * Map a Web Speech API error code (`SpeechRecognitionErrorEvent.error`, or a
 * `start()` exception) to a translation key under the `search` namespace, so a
 * failed dictation shows an actionable message instead of failing silently.
 */
function voiceErrorKey(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "voiceErrorNotAllowed";
    case "audio-capture":
      return "voiceErrorNoMicrophone";
    case "network":
      return "voiceErrorNetwork";
    case "language-not-supported":
      return "voiceErrorLanguage";
    case "no-speech":
      return "voiceErrorNoSpeech";
    default:
      return "voiceErrorGeneric";
  }
}

export interface VoiceSearchButtonProps {
  /**
   * Called as dictation produces text. `isFinal` marks the terminal result of
   * an utterance — the caller typically fills the query on every call and
   * submits when `isFinal` is true.
   */
  onResult: (transcript: string, isFinal: boolean) => void;
}

/**
 * Microphone button that drives voice search via the Web Speech API. Renders
 * nothing until the browser is confirmed to expose SpeechRecognition (resolved
 * in an effect, not during render, so the first client render matches the
 * server — which has no `window` — and avoids a hydration mismatch; the button
 * appears immediately after mount). Dictation is reported through `onResult`.
 */
export function VoiceSearchButton({ onResult }: VoiceSearchButtonProps) {
  const t = useTranslations("search");
  const locale = useLocale();

  // The installed shell declares no microphone use, so asking for one there is
  // a store rejection rather than a feature. Defer the browser-only lookup
  // until after hydration so the initial client render still matches SSR.
  const speechCtor =
    useHydrated() && shellFeatureBoundary().microphone ? getSpeechRecognition() : undefined;

  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Bumped on every start/stop/unmount so a slow getUserMedia that resolves
  // after the user cancelled (or the component unmounted) doesn't start a
  // recognition behind their back.
  const voiceSessionRef = useRef(0);
  // Surfaced when dictation fails (permission blocked, no network, etc.) so the
  // mic button reports the reason instead of silently doing nothing.
  const [voiceError, setVoiceError] = useState<string | null>(null);

  // Keep the latest onResult without re-creating startVoiceSearch each render.
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const startVoiceSearch = useCallback(() => {
    if (!speechCtor) return;
    setVoiceError(null);
    const session = ++voiceSessionRef.current;

    const beginRecognition = () => {
      // Detach the previous instance's handlers before aborting so its late
      // `aborted` onerror/onend can't flip this new session's state.
      const prev = recognitionRef.current;
      if (prev) {
        prev.onresult = null;
        prev.onerror = null;
        prev.onend = null;
        prev.abort();
      }
      const rec = new speechCtor();
      rec.lang = speechLang(locale);
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0]?.transcript ?? "";
        }
        transcript = transcript.trim();
        if (!transcript) return;
        const isFinal = event.results[event.results.length - 1]?.isFinal ?? false;
        onResultRef.current(transcript, isFinal);
      };
      rec.onerror = (event) => {
        setListening(false);
        console.warn("[voice-search] recognition error:", event.error);
        setVoiceError(t(voiceErrorKey(event.error)));
      };
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      try {
        rec.start();
      } catch (err) {
        setListening(false);
        console.warn("[voice-search] start() threw:", err);
        setVoiceError(t(voiceErrorKey(undefined)));
      }
    };

    setListening(true);

    // In installed PWAs on Android, SpeechRecognition.start() can fail with
    // `not-allowed` without ever prompting, whereas getUserMedia reliably raises
    // the system mic prompt and grants access — so request (and immediately
    // release) it first, then start recognition. The preflight is best-effort:
    // if getUserMedia is unavailable or rejected (e.g. blocked by a
    // Permissions-Policy in a context where Web Speech still works), fall through
    // to recognition anyway. If recognition is genuinely blocked, its own onerror
    // surfaces the specific reason.
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      console.warn("[voice-search] navigator.mediaDevices.getUserMedia unavailable");
      beginRecognition();
      return;
    }
    media
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Release the mic immediately so recognition can capture it.
        for (const track of stream.getTracks()) track.stop();
        if (voiceSessionRef.current !== session) return; // cancelled meanwhile
        beginRecognition();
      })
      .catch((err: unknown) => {
        const name = err instanceof DOMException ? err.name : String(err);
        console.warn(
          "[voice-search] getUserMedia rejected:",
          name,
          "— trying recognition directly",
        );
        if (voiceSessionRef.current !== session) return; // cancelled meanwhile
        beginRecognition();
      });
  }, [speechCtor, locale, t]);

  const toggleVoiceSearch = useCallback(() => {
    if (listening) {
      voiceSessionRef.current++; // invalidate any pending getUserMedia preflight
      recognitionRef.current?.stop();
      setListening(false);
    } else {
      startVoiceSearch();
    }
  }, [listening, startVoiceSearch]);

  // Stop recognition if the component unmounts mid-listen (and invalidate any
  // in-flight getUserMedia preflight so it can't start recognition after unmount).
  useEffect(
    () => () => {
      voiceSessionRef.current++;
      recognitionRef.current?.abort();
    },
    [],
  );

  if (!speechCtor) return null;

  return (
    <>
      <IconButton
        size="small"
        onClick={toggleVoiceSearch}
        onMouseDown={(e) => e.preventDefault()}
        aria-label={t("voiceSearchAriaLabel")}
      >
        <MicIcon sx={{ fontSize: 22, color: listening ? "error.main" : "text.secondary" }} />
      </IconButton>

      <Snackbar
        open={voiceError !== null}
        autoHideDuration={6000}
        onClose={() => setVoiceError(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          severity="warning"
          variant="filled"
          onClose={() => setVoiceError(null)}
          sx={{ width: "100%" }}
        >
          {voiceError}
        </Alert>
      </Snackbar>
    </>
  );
}
