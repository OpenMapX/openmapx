import { useCallback } from "react";
import { hasCapability } from "../platformCapabilities";

/** Returns a `speak(text)` function backed by SpeechSynthesis (locale-aware). No-op when unsupported. */
export function useNavigationVoice(locale: string): (text: string) => void {
  return useCallback(
    (text: string) => {
      if (!hasCapability("speech")) return;
      const u = new window.SpeechSynthesisUtterance(text);
      u.lang = locale;
      window.speechSynthesis.speak(u);
    },
    [locale],
  );
}
