import { useEffect, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
export type AppVisibility = "active" | "inactive" | "background";

/**
 * The app's visibility, as recovery and the web page's visibility understand it.
 *
 * `inactive` is kept distinct from `background` rather than folded into it: on
 * iOS it covers the app switcher and an incoming call, and a foreground-only
 * session must stop for both — treating `inactive` as "still visible" would let
 * tracking continue in exactly the moments the user thinks they left the app.
 */
function toVisibility(status: AppStateStatus): AppVisibility {
  if (status === "active") return "active";
  if (status === "background") return "background";
  return "inactive";
}

export function useAppVisibility(): AppVisibility {
  const [visibility, setVisibility] = useState<AppVisibility>(() =>
    toVisibility(AppState.currentState),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (status) => {
      setVisibility(toVisibility(status));
    });
    return () => subscription.remove();
  }, []);

  return visibility;
}

export const appStateToVisibility = toVisibility;
