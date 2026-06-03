import type { RerouteOpts } from "./types";

/**
 * Decide whether to trigger an online reroute: the last `consecutiveFixes`
 * deviations must all exceed `thresholdMeters`, and the debounce window since
 * the last reroute must have elapsed.
 */
export function shouldReroute(
  deviationHistory: number[],
  lastRerouteAtMs: number | null,
  nowMs: number,
  opts: RerouteOpts,
): boolean {
  if (lastRerouteAtMs !== null && nowMs - lastRerouteAtMs < opts.debounceMs) return false;
  if (deviationHistory.length < opts.consecutiveFixes) return false;
  const recent = deviationHistory.slice(-opts.consecutiveFixes);
  return recent.every((d) => d > opts.thresholdMeters);
}
