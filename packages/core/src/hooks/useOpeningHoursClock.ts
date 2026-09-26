import { useEffect, useState } from "react";

/** Rerenders mounted hours consumers even when an offline cache object is unchanged. */
export function useOpeningHoursClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") tick();
    }, 15_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return now;
}
