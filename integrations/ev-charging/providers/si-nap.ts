import { type BoundingBox, fetchJson } from "@openmapx/core";
import { createStaticPoiReader } from "@openmapx/integration-framework";
import type { EvChargingSource, EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import type { BBox, PoiSourceLogger } from "@openmapx/poi-source-registry";
import { getRuntimeContext } from "../runtime.js";
import { createPayloadStationMapper } from "./payload-station.js";
import { getEvChargingSourcePriority } from "./source-priority.js";

const STATION_ID_PREFIX = "si-nap:";

// NAP Slovenija (nap.si) doesn't hand out a static bearer token — access is
// OAuth2 (RFC 6749), documented in nap_B2B_en.pdf ("Data requests"): an
// operator first does a one-time password-grant login (their nap.si email +
// password) to obtain an `access_token` + long-lived `refresh_token`, then
// every dataset request needs a fresh `access_token`, refreshed via
// `grant_type=refresh_token`. There is no way to do the password grant
// server-side without storing the raw account password, so the credential
// OpenMapX stores ("si-nap-api-key", see manifest.json) is that long-lived
// `refresh_token` — the operator obtains it once (see the setup guide) and
// we exchange it for short-lived access tokens here, caching in module
// scope. This mirrors MdbClient's refresh-token -> access-token pattern
// (integrations/transit-mobility-database/client.ts).
const SI_NAP_TOKEN_URL = "https://b2b.nap.si/uc/user/token";
const ACCESS_TOKEN_SAFETY_SECONDS = 60;

let siNapRefreshToken: string | undefined;
let cachedAccessToken: string | undefined;
let cachedAccessTokenExpiresAt = 0;

/** Wired from `ctx.config["si-nap-api-key"]` in index.ts `setup()`. */
export function setSiNapToken(value: string | undefined): void {
  siNapRefreshToken = value && value.length > 0 ? value : undefined;
  // A newly-set (or cleared) credential invalidates any access token cached
  // against the previous one.
  cachedAccessToken = undefined;
  cachedAccessTokenExpiresAt = 0;
}

interface SiNapTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

async function exchangeSiNapToken(log: PoiSourceLogger): Promise<string> {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: siNapRefreshToken as string,
  });
  let body: SiNapTokenResponse;
  try {
    body = await fetchJson<SiNapTokenResponse>(SI_NAP_TOKEN_URL, {
      init: { method: "POST", body: params.toString() },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      label: "SI NAP token exchange",
    });
  } catch (err) {
    log.error("SI NAP token exchange failed", err);
    throw err;
  }
  cachedAccessToken = body.access_token;
  const expiresInSeconds = Number.isFinite(body.expires_in) ? body.expires_in : 3600;
  cachedAccessTokenExpiresAt =
    Date.now() + Math.max(expiresInSeconds - ACCESS_TOKEN_SAFETY_SECONDS, 0) * 1000;
  // NAP doesn't document whether the refresh token rotates on use; if the
  // response carries a new one, adopt it so a rotating-token server keeps
  // working across ingest runs.
  if (body.refresh_token) siNapRefreshToken = body.refresh_token;
  return cachedAccessToken;
}

/**
 * `resolveHeaders` for the SI NAP poi-ingest fetch spec (see poi-sources.ts).
 * Throws when no token is configured — the fetch stage
 * (services/data-manager/src/jobs/poi-ingest/stages/fetch.ts) turns a
 * `resolveHeaders` throw into a clean fetch-stage error with no HTTP request
 * ever made and no rows persisted or swapped in, i.e. the source is fully
 * inert until an operator configures "si-nap-api-key".
 */
export async function resolveSiNapHeaders(log: PoiSourceLogger): Promise<Record<string, string>> {
  if (!siNapRefreshToken) {
    throw new Error("SI NAP API token not configured; skipping ingest.");
  }
  const now = Date.now();
  const accessToken =
    cachedAccessToken && now < cachedAccessTokenExpiresAt
      ? cachedAccessToken
      : await exchangeSiNapToken(log);
  return { Authorization: `Bearer ${accessToken}` };
}

const reader = createStaticPoiReader<EvChargingStation>({
  sourceId: "si-nap",
  mapStatic: createPayloadStationMapper({ sourceId: "si-nap", stationIdPrefix: STATION_ID_PREFIX }),
  // [west, south, east, north] — Slovenia.
  coverage: [13.3, 45.4, 16.6, 46.9],
});

function toBboxTuple(b: BoundingBox): BBox {
  return [b.west, b.south, b.east, b.north];
}

export async function searchSiNapCharging(bbox: BoundingBox): Promise<EvChargingStation[]> {
  return reader.search(getRuntimeContext(), toBboxTuple(bbox));
}

export async function fetchSiNapChargingDetail(itemId: string): Promise<EvChargingStation | null> {
  const poiId = itemId.startsWith(STATION_ID_PREFIX)
    ? itemId.slice(STATION_ID_PREFIX.length)
    : itemId;
  return reader.fetchDetail(getRuntimeContext(), poiId);
}

export const siNapSource: EvChargingSource = {
  id: "si-nap",
  priority: getEvChargingSourcePriority("si-nap"),
  search: searchSiNapCharging,
  canFetchDetail: (itemId) => itemId.startsWith(STATION_ID_PREFIX),
  fetchDetail: fetchSiNapChargingDetail,
};
