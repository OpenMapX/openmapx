import { type BoundingBox, fetchJson, haversineKm } from "@openmapx/core";
import { formatAddress } from "@openmapx/integration-geocoding/format-address";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import type { FuelPriceProvider } from "./price-provider";

// Germany bounding box (with a small margin)
const GERMANY = { minLat: 47.0, maxLat: 55.5, minLng: 5.5, maxLng: 15.5 };
const DE_TANKERKOENIG_URL = "https://creativecommons.tankerkoenig.de/json/list.php";
const MAX_RADIUS_KM = 25;

interface DeTankerkoenigStation {
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

interface DeTankerkoenigListResponse {
  ok: boolean;
  stations: DeTankerkoenigStation[];
  message?: string;
}

export class DeTankerkoenigService implements FuelPriceProvider {
  readonly name = "de-tankerkoenig";

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

    const url = new URL(DE_TANKERKOENIG_URL);
    url.searchParams.set("lat", String(centerLat));
    url.searchParams.set("lng", String(centerLng));
    url.searchParams.set("rad", String(radiusKm));
    url.searchParams.set("sort", "dist");
    url.searchParams.set("type", "all");
    url.searchParams.set("apikey", this.apiKey);

    const data = await fetchJson<DeTankerkoenigListResponse>(url.toString(), {
      errorMessage: ({ status }) => `Tankerkoenig API error: ${status}`,
    });
    if (!data.ok) throw new Error(`Tankerkoenig: ${data.message ?? "ok=false"}`);

    return data.stations.map((s) => {
      const address =
        formatAddress(
          {
            road: s.street,
            house_number: s.houseNumber,
            postcode: s.postCode,
            city: s.place,
            country_code: "de",
          },
          { appendCountry: false },
        ) || undefined;

      const nameStartsWithBrand = s.brand && s.name.toLowerCase().startsWith(s.brand.toLowerCase());
      const displayName = s.brand && !nameStartsWithBrand ? `${s.brand} ${s.name}` : s.name;

      return {
        id: `de-tankerkoenig/${s.id}`,
        name: displayName,
        brand: s.brand || undefined,
        coordinates: [s.lng, s.lat],
        address,
        isOpen: s.isOpen,
        fuelPrices: {
          e5: s.e5 != null && s.e5 !== false ? s.e5 : undefined,
          e10: s.e10 != null && s.e10 !== false ? s.e10 : undefined,
          diesel: s.diesel != null && s.diesel !== false ? s.diesel : undefined,
        },
      };
    });
  }
}
