import { type BoundingBox, fetchJson } from "@openmapx/core";
import type { FuelStation } from "@openmapx/mobility-core/fuel";
import type { FuelPriceProvider } from "./price-provider";

// Spain mainland + Balearics + Canary Islands bounding box
const SPAIN = { minLat: 27.6, maxLat: 43.8, minLng: -18.2, maxLng: 4.4 };
const API_URL =
  "https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/";
// The nationwide feed was 12.1 MB in August 2026. This reviewed bulk limit is
// intentionally larger than the ordinary API ceiling but remains bounded.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// Cache the full station list — prices are updated daily
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let _cache: { stations: EsMineturStation[]; expires: number } | null = null;
let _inflight: Promise<EsMineturStation[]> | null = null;

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

interface EsMineturStation {
  IDEESS: string;
  Rótulo: string;
  Dirección: string;
  Municipio: string;
  Latitud: string;
  "Longitud (WGS84)": string;
  "Precio Gasoleo A": string;
  "Precio Gasolina 95 E5": string;
  "Precio Gasolina 95 E10": string;
  "Precio Gasolina 98 E5": string;
  "Precio Gases licuados del petróleo": string;
}

interface EsMineturResponse {
  ListaEESSPrecio: EsMineturStation[];
}

async function fetchAllStations(): Promise<EsMineturStation[]> {
  if (_cache && _cache.expires > Date.now()) return _cache.stations;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const data = await fetchJson<EsMineturResponse>(API_URL, {
      headers: { Accept: "application/json" },
      maxBytes: MAX_RESPONSE_BYTES,
      errorMessage: ({ status }) => `Spain fuel API error: ${status}`,
    });
    const stations = data.ListaEESSPrecio;
    _cache = { stations, expires: Date.now() + CACHE_TTL_MS };
    return stations;
  })().finally(() => {
    _inflight = null;
  });

  return _inflight;
}

export class EsMineturService implements FuelPriceProvider {
  readonly name = "es-minetur";

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
          id: `es-minetur/${s.IDEESS}`,
          name: s.Rótulo || address || s.IDEESS,
          coordinates: [lng, lat],
          address,
          currency: "EUR",
          fuelPrices: {
            diesel: parseSpanishPrice(s["Precio Gasoleo A"]),
            e5: parseSpanishPrice(s["Precio Gasolina 95 E5"]),
            e10: parseSpanishPrice(s["Precio Gasolina 95 E10"]),
            sp98: parseSpanishPrice(s["Precio Gasolina 98 E5"]),
            lpg: parseSpanishPrice(s["Precio Gases licuados del petróleo"]),
          },
        };
      });
  }
}
