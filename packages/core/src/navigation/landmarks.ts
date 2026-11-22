/**
 * Landmarks a voice prompt may name at a manoeuvre ("at the Aral petrol
 * station"). The routing integration's `POST /navigation/landmarks` answers
 * with these candidates per manoeuvre point; selection happens on the client.
 */

/** OSM categories the server returns; `place_of_worship` is narrowed by `religion`. */
export type LandmarkCandidateCategory =
  | "fuel"
  | "place_of_worship"
  | "pharmacy"
  | "supermarket"
  | "fast_food";

export interface LandmarkCandidate {
  category: LandmarkCandidateCategory;
  /** OSM `brand`, at most 40 characters. Required for `fast_food`. */
  brand?: string;
  /** OSM `religion` for `place_of_worship`: christian, muslim or jewish. */
  religion?: string;
  /** The node, or the centre of a way or relation. */
  lat: number;
  lon: number;
  /** A way's outline as `[lng, lat]` pairs, for the distance rule. */
  outline?: [number, number][];
}
