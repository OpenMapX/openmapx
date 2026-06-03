import {
  navOptionsForMode,
  processFix,
  simulatePositions,
  useNavigationStore,
} from "@openmapx/core";

/**
 * Dev helper: replay the active route's geometry as fake GPS fixes through the
 * store, advancing one fix per `intervalMs`. Call from the browser console:
 *   import("@/lib/navigation/devSimulator").then(m => m.runSimulator())
 * Returns a stop() function.
 */
export function runSimulator(intervalMs = 1000, offsetMeters = 0): () => void {
  if (process.env.NODE_ENV === "production") return () => {};
  const store = useNavigationStore.getState();
  const route = store.route;
  if (!route) {
    console.warn("[devSimulator] start navigation first");
    return () => {};
  }
  const fixes = simulatePositions(route.geometry, { stepMeters: 25, intervalMs, offsetMeters });
  const opts = navOptionsForMode(route.mode);
  let tick = {
    deviationHistory: [] as number[],
    lastRerouteAtMs: null as number | null,
    spokenCues: [] as string[],
  };
  let i = 0;
  const handle = setInterval(() => {
    if (i >= fixes.length) {
      clearInterval(handle);
      return;
    }
    const result = processFix(useNavigationStore.getState().route ?? route, fixes[i++], tick, opts);
    tick = result.nextState;
    if (result.progress) {
      useNavigationStore.getState().applyProgress(result.progress);
      useNavigationStore.getState().setOffRoute(result.offRoute);
      if (result.arrived) useNavigationStore.getState().completeArrival();
    }
  }, intervalMs);
  return () => clearInterval(handle);
}
