import { type BoundingBox, fetchJson, haversineKm } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import type { FuelPriceProvider } from "./price-provider";

// Austria bounding box
const AUSTRIA = { minLat: 46.4, maxLat: 49.0, minLng: 9.5, maxLng: 17.2 };
const MAX_RADIUS_KM = 50;
const BASE_URL = "https://api.e-control.at/sprit/1.0/search/gas-stations/by-address";

interface AustriaPrice {
  fuelType: string;
  amount: number;
}

interface AustriaStation {
  id: number;
  name: string;
  location: {
    address: string;
    postalCode: string;
    city: string;
    latitude: number;
    longitude: number;
  };
  open: boolean;
  prices: AustriaPrice[];
}

async function fetchByFuelType(
  lat: number,
  lng: number,
  radius: number,
  fuelType: string,
): Promise<AustriaStation[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("fuelType", fuelType);
  url.searchParams.set("includeClosed", "false");
  url.searchParams.set("radius", String(radius));

  return fetchJson<AustriaStation[]>(url.toString(), {
    errorMessage: ({ status }) => `Austria fuel API error: ${status}`,
  });
}

export class AustriaService implements FuelPriceProvider {
  readonly name = "e-control-at";

  supports(bbox: BoundingBox): boolean {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    return (
      centerLat >= AUSTRIA.minLat &&
      centerLat <= AUSTRIA.maxLat &&
      centerLng >= AUSTRIA.minLng &&
      centerLng <= AUSTRIA.maxLng
    );
  }

  async searchStations(bbox: BoundingBox): Promise<FuelStation[]> {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    const radiusKm = Math.min(
      MAX_RADIUS_KM,
      Math.ceil(haversineKm(centerLat, centerLng, bbox.north, bbox.east)),
    );

    // Fetch diesel and Super 95 in parallel; merge by station id
    const [dieselStations, superStations] = await Promise.all([
      fetchByFuelType(centerLat, centerLng, radiusKm, "DIE"),
      fetchByFuelType(centerLat, centerLng, radiusKm, "SUP"),
    ]);

    // Index super prices by station id
    const superPriceById = new Map<number, number>();
    for (const s of superStations) {
      const p = s.prices.find((p) => p.fuelType === "SUP");
      if (p) superPriceById.set(s.id, p.amount);
    }

    return dieselStations.map((s) => {
      const dieselPrice = s.prices.find((p) => p.fuelType === "DIE")?.amount;
      const address =
        [s.location.address, s.location.postalCode, s.location.city].filter(Boolean).join(", ") ||
        undefined;

      return {
        id: `e-control-at/${s.id}`,
        name: s.name,
        coordinates: [s.location.longitude, s.location.latitude],
        address,
        isOpen: s.open,
        fuelPrices: {
          diesel: dieselPrice,
          e5: superPriceById.get(s.id),
        },
      };
    });
  }
}
