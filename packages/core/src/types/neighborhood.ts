import type { LngLat } from "./geometry";

/**
 * A neighbourhood / suburb / quarter within a city, surfaced in the city place
 * panel. Built from OSM `place=suburb|neighbourhood|quarter|borough` and
 * optionally enriched with a Wikipedia thumbnail + extract.
 */
export interface NeighborhoodCard {
  /** Stable id — the OSM ref (`node/123`, `relation/456`) when available. */
  id: string;
  name: string;
  coordinates: LngLat;
  /** First sentence of the Wikipedia extract, when one is available. */
  description?: string;
  /** Wikipedia/Commons thumbnail URL, when one is available. */
  photoUrl?: string;
  wikipediaUrl?: string;
}

export interface NeighborhoodsResponse {
  neighborhoods: NeighborhoodCard[];
}
