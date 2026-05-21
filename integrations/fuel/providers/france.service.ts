import type { BoundingBox } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import type { FuelPriceProvider } from "./price-provider";

// France mainland + Corsica bounding box
const FRANCE = { minLat: 41.3, maxLat: 51.1, minLng: -5.2, maxLng: 9.6 };
const MAX_RADIUS_KM = 50;
const MAX_RESULTS = 100;
const BASE_URL =
  "https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records";

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface FranceRecord {
  id: string;
  adresse?: string;
  ville?: string;
  geom: { lon: number; lat: number };
  gazole_prix?: number | null;
  gazole_maj?: string | null;
  sp95_prix?: number | null;
  sp95_maj?: string | null;
  e10_prix?: number | null;
  e10_maj?: string | null;
  sp98_prix?: number | null;
  sp98_maj?: string | null;
  e85_prix?: number | null;
  e85_maj?: string | null;
  gplc_prix?: number | null;
  gplc_maj?: string | null;
}

interface FranceResponse {
  results: FranceRecord[];
}

export class FranceService implements FuelPriceProvider {
  readonly name = "prix-carburants-fr";

  supports(bbox: BoundingBox): boolean {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    return (
      centerLat >= FRANCE.minLat &&
      centerLat <= FRANCE.maxLat &&
      centerLng >= FRANCE.minLng &&
      centerLng <= FRANCE.maxLng
    );
  }

  async searchStations(bbox: BoundingBox): Promise<FuelStation[]> {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    const radiusKm = Math.min(
      MAX_RADIUS_KM,
      Math.ceil(haversineKm(centerLat, centerLng, bbox.north, bbox.east)),
    );

    const where = `distance(geom, geom'POINT(${centerLng} ${centerLat})', ${radiusKm}km)`;
    const url = new URL(BASE_URL);
    url.searchParams.set("where", where);
    url.searchParams.set("limit", String(MAX_RESULTS));
    url.searchParams.set(
      "select",
      "id,adresse,ville,geom,gazole_prix,gazole_maj,sp95_prix,sp95_maj,e10_prix,e10_maj,sp98_prix,sp98_maj,e85_prix,e85_maj,gplc_prix,gplc_maj",
    );

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`France fuel API error: ${res.status}`);

    const data = (await res.json()) as FranceResponse;

    return data.results.map((r) => {
      const address = [r.adresse, r.ville].filter(Boolean).join(", ") || undefined;

      // Pick the most recent update timestamp across available fuel types
      const timestamps = [
        r.gazole_maj,
        r.sp95_maj,
        r.e10_maj,
        r.sp98_maj,
        r.e85_maj,
        r.gplc_maj,
      ].filter(Boolean) as string[];
      const updatedAt = timestamps.length
        ? timestamps.reduce((latest, t) => (t > latest ? t : latest))
        : undefined;

      return {
        id: `prix-carburants-fr/${r.id}`,
        name: address ?? r.id,
        coordinates: [r.geom.lon, r.geom.lat],
        address,
        fuelPricesUpdatedAt: updatedAt,
        fuelPrices: {
          diesel: r.gazole_prix ?? undefined,
          e5: r.sp95_prix ?? undefined,
          e10: r.e10_prix ?? undefined,
          sp98: r.sp98_prix ?? undefined,
          e85: r.e85_prix ?? undefined,
          lpg: r.gplc_prix ?? undefined,
        },
      };
    });
  }
}
