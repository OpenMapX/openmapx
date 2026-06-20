import { diceSimilarity, haversineMeters } from "@openmapx/core";

const RADIUS_M = 150;

export interface OsmPoi {
  osmType: string;
  osmId: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
}

export interface OverturePlace {
  gersId: string;
  name: string;
  lat: number;
  lng: number;
  category?: string;
  address?: string;
}

export interface CandidatePair {
  osmPoi: OsmPoi;
  overturePlace: OverturePlace;
  distanceM: number;
  nameDice: number;
}

const BANDS = [
  { min: 0, max: 0.4 },
  { min: 0.4, max: 0.7 },
  { min: 0.7, max: 0.9 },
  { min: 0.9, max: Infinity },
];

function sampleBands(pairs: CandidatePair[], targetTotal: number): CandidatePair[] {
  const buckets: CandidatePair[][] = BANDS.map(() => []);
  for (const pair of pairs) {
    for (let i = 0; i < BANDS.length; i++) {
      const band = BANDS[i];
      if (pair.nameDice >= band.min && pair.nameDice < band.max) {
        buckets[i].push(pair);
        break;
      }
    }
  }
  const perBand = Math.ceil(targetTotal / BANDS.length);
  const result: CandidatePair[] = [];
  for (const bucket of buckets) {
    result.push(...bucket.slice(0, perBand));
  }
  return result;
}

export function generateCandidatePairs(
  osmPois: OsmPoi[],
  overturePlaces: OverturePlace[],
  opts: { targetPairs?: number } = {},
): CandidatePair[] {
  const targetPairs = opts.targetPairs ?? 300;
  const allPairs: CandidatePair[] = [];

  for (const osm of osmPois) {
    if (!osm.name) continue;
    for (const ov of overturePlaces) {
      const distanceM = haversineMeters(osm.lat, osm.lng, ov.lat, ov.lng);
      if (distanceM > RADIUS_M) continue;
      const nameDice = diceSimilarity(osm.name, ov.name);
      allPairs.push({ osmPoi: osm, overturePlace: ov, distanceM, nameDice });
    }
  }

  return sampleBands(allPairs, targetPairs);
}
