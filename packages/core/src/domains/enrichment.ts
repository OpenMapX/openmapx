import type { Place } from "../types/place";

export interface EnrichmentProvider {
  readonly id: string;
  enrich(place: Place): Promise<Partial<Place>>;
}
