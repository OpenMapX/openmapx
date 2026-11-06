/** Source-independent explicit itinerary; wall clocks carry an explicit calendar date. */
export interface SharedTravelLeg {
  from: string;
  to: string;
  departure: string;
  arrival: string;
  service: string;
  trainNumber: string;
  headsign?: string;
  departurePlatform?: string;
  arrivalPlatform?: string;
}
export interface SharedTravelPlan {
  sourceId: string;
  sourceLabel: string;
  origin: string;
  destination: string;
  timeZone: string;
  legs: SharedTravelLeg[];
}
export type TravelPlanParseResult =
  | { kind: "unrecognized" }
  | { kind: "invalid-travel-plan"; reason: "invalid" | "missing-text" | "too-large" }
  | { kind: "travel-plan"; plan: SharedTravelPlan };
export interface TravelPlanAdapter {
  parse(text: string): TravelPlanParseResult;
}
/** Retain locality qualifiers: Frankfurt(Main) and Frankfurt(Oder) are different. */
export function travelStationKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replace(/hauptbahnhof|hbf\.?/g, " hbf ")
    .replace(/\bbahnhof\b|\bbf\.?/g, " bf ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}
