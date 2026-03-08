import type { BoundingBox } from "../overpass.service";
import type { FuelPriceProvider } from "./provider";
import type { FuelStation } from "./types";

// Spain mainland + Balearics + Canary Islands bounding box
const SPAIN = { minLat: 27.6, maxLat: 43.8, minLng: -18.2, maxLng: 4.4 };
const API_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";

// Cache the full station list — prices are updated daily
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cache: { stations: SpainStation[]; expires: number } | null = null;

function parseSpanishPrice(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const n = Number.parseFloat(value.replace(",", "."));
  return Number.isNaN(n) ? undefined : n;
}

function parseSpanishCoord(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value.replace(",", "."));
  return Number.isNaN(n) ? undefined : n;
}

interface SpainStation {
  IDEESS: string;
  Rótulo: string;
  Dirección: string;
  Municipio: string;
  Latitud: string;
  "Longitud (WGS84)": string;
  "Precio Gasoleo A": string;
  "Precio Gasolina 95 E5": string;
  "Precio Gasolina 95 E10": string;
}

interface SpainResponse {
  ListaEESSPrecio: SpainStation[];
}

async function fetchAllStations(): Promise<SpainStation[]> {
  if (_cache && _cache.expires > Date.now()) return _cache.stations;

  const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Spain fuel API error: ${res.status}`);

  const data = (await res.json()) as SpainResponse;
  const stations = data.ListaEESSPrecio;
  _cache = { stations, expires: Date.now() + CACHE_TTL_MS };
  return stations;
}

export class SpainService implements FuelPriceProvider {
  readonly name = "minetur-es";

  supports(bbox: BoundingBox): boolean {
    const centerLat = (bbox.north + bbox.south) / 2;
    const centerLng = (bbox.east + bbox.west) / 2;
    return (
      centerLat >= SPAIN.minLat &&
      centerLat <= SPAIN.maxLat &&
      centerLng >= SPAIN.minLng &&
      centerLng <= SPAIN.maxLng
    );
  }

  async searchStations(bbox: BoundingBox): Promise<FuelStation[]> {
    const all = await fetchAllStations();

    return all
      .filter((s) => {
        const lat = parseSpanishCoord(s.Latitud);
        const lng = parseSpanishCoord(s["Longitud (WGS84)"]);
        if (lat === undefined || lng === undefined) return false;
        return lat >= bbox.south && lat <= bbox.north && lng >= bbox.west && lng <= bbox.east;
      })
      .map((s) => {
        const lat = parseSpanishCoord(s.Latitud) as number;
        const lng = parseSpanishCoord(s["Longitud (WGS84)"]) as number;
        const address = [s.Dirección, s.Municipio].filter(Boolean).join(", ") || undefined;

        return {
          id: `minetur-es/${s.IDEESS}`,
          name: s.Rótulo || address || s.IDEESS,
          coordinates: [lng, lat],
          address,
          attribution: {
            label: "Ministerio para la Transición Ecológica",
            url: "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/help",
          },
          fuelPrices: {
            diesel: parseSpanishPrice(s["Precio Gasoleo A"]),
            e5: parseSpanishPrice(s["Precio Gasolina 95 E5"]),
            e10: parseSpanishPrice(s["Precio Gasolina 95 E10"]),
          },
        };
      });
  }
}
