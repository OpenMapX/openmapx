/**
 * NRW Mobidrom bundled E-Scooter Sharing feed.
 *
 * Aggregator covering 14 operator/city feeds (Voi in 11 NRW cities, Lime in 2).
 * Conflates them into a single GBFS 3.0 manifest. Real-time vehicle positions
 * with 5-minute update frequency per CKAN metadata.
 *
 * Format: standard GBFS 3.0 (datasets → per-system gbfs.json → feeds).
 * License: per-operator data licenses, re-published by NRW.Mobidrom GmbH.
 * Auth: OAuth 2.0 client credentials (Keycloak). Credentials are published
 * publicly on the dataset page for any API consumer.
 *
 * Dataset: https://www.mobilitaetsdaten.nrw/dataset/e-scooter-sharing-nrw
 */

import { type BoundingBox, bboxContains, type LngLat } from "@openmapx/core";
import { normalizeFormFactor, normalizeGbfsPropulsion } from "@openmapx/mobility-core/gbfs-catalog";
import { fetchGbfsSystem } from "@openmapx/mobility-core/gbfs-client";
import type { MobilityHttpTransport } from "@openmapx/mobility-core/json-transport";
import type {
  SharedMobilityStation,
  SharedMobilityVehicle,
  VehicleFormFactor,
} from "@openmapx/mobility-core/shared-mobility";

const TOKEN_URL =
  "https://www.mobilitaetsdaten.nrw/keycloak/realms/mobidrom/protocol/openid-connect/token";
const MANIFEST_URL =
  "https://www.mobilitaetsdaten.nrw/api/systemadapter-gbfs-provider/conflated/v3.0/e-scooter-sharing-nrw/manifest.json";

// Public credentials documented on the dataset page. Override via env if
// rotated. See https://www.mobilitaetsdaten.nrw/dataset/e-scooter-sharing-nrw
const DEFAULT_CLIENT_ID = "gbfs-api";
const DEFAULT_CLIENT_SECRET = "OhQP9ryrXU7lnjQ9qteZib3rnys2wkTB";

const SOURCE = "de-nw-mobidrom-scooter";
const FETCH_TIMEOUT_MS = 8_000;
const FEED_CACHE_MS = 2 * 60 * 1000; // 2 min (feed updates every 5 min)

/**
 * Hosts allowed to receive the operator bearer token. The manifest and the
 * per-system discovery documents are remote content, so without this the
 * token would follow whatever host they name.
 */
const CREDENTIAL_HOSTS = ["www.mobilitaetsdaten.nrw", "*.mobilitaetsdaten.nrw"];

// NRW bounding box for fast pre-filter (full federal state)
const COVERAGE_BBOX: BoundingBox = { south: 50.32, west: 5.87, north: 52.53, east: 9.46 };

interface ClientState {
  clientId?: string;
  clientSecret?: string;
  tokenCache: TokenCache | null;
  inflightToken: Promise<string | null> | null;
  feedCache: FeedCache | null;
  inflightFeed: Promise<FeedCache> | null;
}

function clientId(state: ClientState): string {
  return state.clientId ?? DEFAULT_CLIENT_ID;
}

function clientSecret(state: ClientState): string {
  return state.clientSecret ?? DEFAULT_CLIENT_SECRET;
}

interface TokenCache {
  token: string;
  expiresAt: number; // epoch ms
}

interface TokenResponse {
  access_token: string;
  expires_in: number; // seconds
  token_type?: string;
}

async function getAccessToken(
  state: ClientState,
  transport: MobilityHttpTransport,
): Promise<string | null> {
  const now = Date.now();
  // Refresh 60s early to avoid edge-case expiry mid-request
  if (state.tokenCache && state.tokenCache.expiresAt > now + 60_000) {
    return state.tokenCache.token;
  }
  if (state.inflightToken) return state.inflightToken;

  state.inflightToken = (async () => {
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId(state),
        client_secret: clientSecret(state),
      });
      const json = await transport.fetchJson<TokenResponse>(TOKEN_URL, {
        method: "POST",
        body: body.toString(),
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: 1024 * 1024,
        allowedRedirectOrigin: "https://www.mobilitaetsdaten.nrw",
        headers: {
          "User-Agent": transport.userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      if (!json) {
        console.warn("[de-nw-mobidrom-scooter] token request failed");
        return null;
      }
      if (!json.access_token) return null;
      state.tokenCache = {
        token: json.access_token,
        expiresAt: Date.now() + Math.max(60, json.expires_in - 30) * 1000,
      };
      return json.access_token;
    } catch (err) {
      console.warn("[de-nw-mobidrom-scooter] token request error:", err);
      return null;
    } finally {
      state.inflightToken = null;
    }
  })();
  return state.inflightToken;
}

interface ManifestEntry {
  system_id: string;
  versions: { version: string; url: string }[];
}

interface Manifest {
  data: { datasets: ManifestEntry[] };
}

interface FeedCache {
  stations: SharedMobilityStation[];
  vehicles: SharedMobilityVehicle[];
  fetchedAt: number;
}

const TARGET_V3 = "3.0";

async function fetchManifest(
  token: string,
  transport: MobilityHttpTransport,
): Promise<ManifestEntry[]> {
  try {
    const json = await transport.fetchJson<Manifest>(MANIFEST_URL, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: 8 * 1024 * 1024,
      allowedRedirectOrigin: "https://www.mobilitaetsdaten.nrw",
      headers: {
        "User-Agent": transport.userAgent,
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
    if (!json) {
      console.warn("[de-nw-mobidrom-scooter] manifest fetch failed");
      return [];
    }
    return json.data?.datasets ?? [];
  } catch (err) {
    console.warn("[de-nw-mobidrom-scooter] manifest fetch error:", err);
    return [];
  }
}

function pickV3Url(entry: ManifestEntry): string | null {
  const v3 = entry.versions.find((v) => v.version === TARGET_V3);
  return v3?.url ?? entry.versions[0]?.url ?? null;
}

function prettifyOperator(systemId: string): string {
  // "source-voi-dortmund" → "Voi Dortmund"
  const tail = systemId.replace(/^source-/, "");
  return tail
    .split("-")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

async function loadAllFeeds(
  transport: MobilityHttpTransport,
  state: ClientState,
): Promise<FeedCache> {
  if (state.feedCache && Date.now() - state.feedCache.fetchedAt < FEED_CACHE_MS) {
    return state.feedCache;
  }
  if (state.inflightFeed) return state.inflightFeed;

  state.inflightFeed = (async () => {
    const token = await getAccessToken(state, transport);
    if (!token) return { stations: [], vehicles: [], fetchedAt: Date.now() };

    const entries = await fetchManifest(token, transport);
    if (entries.length === 0) return { stations: [], vehicles: [], fetchedAt: Date.now() };

    const authHeaders = { Authorization: `Bearer ${token}` };

    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        const gbfsUrl = pickV3Url(entry);
        if (!gbfsUrl) return null;
        const system = await fetchGbfsSystem(gbfsUrl, authHeaders, {
          credentialHosts: CREDENTIAL_HOSTS,
          transport,
        });
        if (!system) return null;
        return { entry, system };
      }),
    );

    const stations: SharedMobilityStation[] = [];
    const vehicles: SharedMobilityVehicle[] = [];

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value) continue;
      const { entry, system } = r.value;
      const operator =
        system.systemInfo?.operator ?? system.systemInfo?.name ?? prettifyOperator(entry.system_id);
      const sourceKey = `${SOURCE}/${entry.system_id}`;

      for (const stInfo of system.stations) {
        const status = system.stationStatuses.get(stInfo.stationId);
        if (!status?.isInstalled || !status.isRenting) continue;

        const stVehicleTypes: VehicleFormFactor[] = [];
        if (status.vehicleTypesAvailable) {
          for (const vta of status.vehicleTypesAvailable) {
            const vt = vta.vehicleTypeId ? system.vehicleTypes.get(vta.vehicleTypeId) : undefined;
            const ff = vt ? normalizeFormFactor(vt.formFactor) : "other";
            if (!stVehicleTypes.includes(ff)) stVehicleTypes.push(ff);
          }
        }
        if (stVehicleTypes.length === 0) stVehicleTypes.push("scooter_standing");

        stations.push({
          id: `${sourceKey}/${stInfo.stationId}`,
          name: stInfo.name || `${operator} Station`,
          coordinates: [stInfo.lon, stInfo.lat] as LngLat,
          availableVehicles: status.numBikesAvailable,
          emptySlots: status.numDocksAvailable,
          capacity: stInfo.capacity,
          operator,
          vehicleTypes: stVehicleTypes,
          isActive: true,
          sources: [SOURCE],
          rentalUris: stInfo.rentalUris,
          website: stInfo.rentalUris?.web,
        });
      }

      for (const v of system.vehicles) {
        if (v.isReserved || v.isDisabled) continue;
        if (!v.lat || !v.lon) continue;
        if (v.stationId) continue;

        const vt = v.vehicleTypeId ? system.vehicleTypes.get(v.vehicleTypeId) : null;
        const formFactor: VehicleFormFactor = vt
          ? normalizeFormFactor(vt.formFactor)
          : "scooter_standing";

        vehicles.push({
          id: `${sourceKey}/${v.bikeId}`,
          coordinates: [v.lon, v.lat] as LngLat,
          formFactor,
          propulsion: vt
            ? (normalizeGbfsPropulsion(vt.propulsionType) as SharedMobilityVehicle["propulsion"])
            : "electric",
          batteryLevel:
            v.currentFuelPercent != null ? Math.round(v.currentFuelPercent * 100) : undefined,
          rangeMeters: v.currentRangeMeters,
          isReserved: false,
          isDisabled: false,
          operator,
          sources: [SOURCE],
        });
      }
    }

    state.feedCache = { stations, vehicles, fetchedAt: Date.now() };
    return state.feedCache;
  })().finally(() => {
    state.inflightFeed = null;
  });

  return state.inflightFeed;
}

function bboxOverlaps(a: BoundingBox, b: BoundingBox): boolean {
  return a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west;
}

/**
 * Fetch NRW e-scooter stations and vehicles within a bounding box.
 */
export function createDeNwMobidromScooterClient(options: {
  clientId?: string;
  clientSecret?: string;
  transport: MobilityHttpTransport;
}): (
  bbox: BoundingBox,
) => Promise<{ stations: SharedMobilityStation[]; vehicles: SharedMobilityVehicle[] }> {
  const state: ClientState = {
    clientId: options.clientId?.trim() || undefined,
    clientSecret: options.clientSecret?.trim() || undefined,
    tokenCache: null,
    inflightToken: null,
    feedCache: null,
    inflightFeed: null,
  };
  return async (bbox) => {
    if (!bboxOverlaps(bbox, COVERAGE_BBOX)) return { stations: [], vehicles: [] };
    const feed = await loadAllFeeds(options.transport, state);
    return {
      stations: feed.stations.filter((station) =>
        bboxContains(bbox, station.coordinates[1], station.coordinates[0]),
      ),
      vehicles: feed.vehicles.filter((vehicle) =>
        bboxContains(bbox, vehicle.coordinates[1], vehicle.coordinates[0]),
      ),
    };
  };
}
