import type { BoundingBox } from "../overpass.service";
import type { FuelPriceProvider } from "./provider";
import type { FuelStation } from "./types";

// Germany bounding box (with a small margin)
const GERMANY = { minLat: 47.0, maxLat: 55.5, minLng: 5.5, maxLng: 15.5 };
const TANKERKOENIG_URL = "https://creativecommons.tankerkoenig.de/json/list.php";
const MAX_RADIUS_KM = 25;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface TankerkoenigStation {
  id: string;
  name: string;
  brand: string;
  street: string;
  houseNumber?: string;
  postCode?: string;
  place: string;
  lat: number;
  lng: number;
  dist: number;
  diesel: number | false | null;
  e5: number | false | null;
  e10: number | false | null;
  isOpen: boolean;
}

interface TankerkoenigListResponse {
  ok: boolean;
  stations: TankerkoenigStation[];
  message?: string;
}

export class TankerkoenigService implements FuelPriceProvider {
  readonly name = "tankerkoenig";

  constructor(private readonly apiKey: string) {}

  supports(bbox: BoundingBox): boolean {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    return (
      centerLat >= GERMANY.minLat &&
      centerLat <= GERMANY.maxLat &&
      centerLng >= GERMANY.minLng &&
      centerLng <= GERMANY.maxLng
    );
  }

  async searchStations(bbox: BoundingBox): Promise<FuelStation[]> {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    const radiusKm = Math.min(
      MAX_RADIUS_KM,
      Math.ceil(haversineKm(centerLat, centerLng, bbox.north, bbox.east)),
    );

    const url = new URL(TANKERKOENIG_URL);
    url.searchParams.set("lat", String(centerLat));
    url.searchParams.set("lng", String(centerLng));
    url.searchParams.set("rad", String(radiusKm));
    url.searchParams.set("sort", "dist");
    url.searchParams.set("type", "all");
    url.searchParams.set("apikey", this.apiKey);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Tankerkoenig API error: ${res.status}`);

    const data = (await res.json()) as TankerkoenigListResponse;
    if (!data.ok) throw new Error(`Tankerkoenig: ${data.message ?? "ok=false"}`);

    return data.stations.map((s) => {
      const streetPart = [s.street, s.houseNumber].filter(Boolean).join(" ");
      const cityPart = [s.postCode, s.place].filter(Boolean).join(" ");
      const address = [streetPart, cityPart].filter(Boolean).join(", ") || undefined;

      const displayName = s.brand && s.brand !== s.name ? `${s.brand} ${s.name}` : s.name;

      return {
        id: `tankerkoenig/${s.id}`,
        name: displayName,
        brand: s.brand || undefined,
        coordinates: [s.lng, s.lat],
        address,
        isOpen: s.isOpen,
        attribution: { label: "Tankerkönig", url: "https://www.tankerkoenig.de" },
        fuelPrices: {
          e5: s.e5 != null && s.e5 !== false ? s.e5 : undefined,
          e10: s.e10 != null && s.e10 !== false ? s.e10 : undefined,
          diesel: s.diesel != null && s.diesel !== false ? s.diesel : undefined,
        },
      };
    });
  }
}
