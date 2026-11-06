import { dbNavigatorAdapter } from "./dbNavigator";
import type { TravelPlanAdapter, TravelPlanParseResult } from "./types";

export type { SharedTravelLeg, SharedTravelPlan, TravelPlanParseResult } from "./types";
export { travelStationKey } from "./types";

/** Explicit registry: new source parsers need no mobile or resolver changes. */
const adapters: readonly TravelPlanAdapter[] = [dbNavigatorAdapter];
export function parseSharedTravelPlan(text: string): TravelPlanParseResult {
  if (text.length > 4096 || new TextEncoder().encode(text).byteLength > 8192)
    return { kind: "invalid-travel-plan", reason: "too-large" };
  if (
    Array.from(text).some(
      (c) =>
        (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) || c.charCodeAt(0) === 127,
    )
  )
    return { kind: "invalid-travel-plan", reason: "invalid" };
  for (const adapter of adapters) {
    const result = adapter.parse(text.trim());
    if (result.kind !== "unrecognized") return result;
  }
  return { kind: "unrecognized" };
}
