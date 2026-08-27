import { readBoundedBinaryResponse } from "@openmapx/core/server";
import { integrationEnvVarName } from "@openmapx/integration-framework";
import type { PoiSourceLogger } from "@openmapx/poi-source-registry";

// EIPA (Ewidencja Infrastruktury Paliw Alternatywnych) — the Polish UDT
// (Urząd Dozoru Technicznego) national alt-fuel/EV register. The reader docs
// (https://eipa.udt.gov.pl/reader/docs, confirmed live 2026-07-29) describe 6
// flat JSON files — dictionary.json, operator.json, pool.json, station.json,
// point.json, dynamic.json — each a `{ data: [...], generated: <iso> }`
// envelope with NO pagination.
//
// Access requires a free reader account
// (https://eipa.udt.gov.pl/reader/register): registering with just an email
// address sends a confirmation link, and activating that link sends a
// follow-up email with "dane dostępowe do pobierania danych z rejestru" (the
// actual base URL + credential for downloading). Neither the reader docs page
// nor the public operator OpenAPI spec (which only covers the OPERATOR write
// API — station/point CRUD — and documents JWT Bearer auth: "Brak
// autoryzacji, podaj prawidłowy token JWT") discloses the reader base URL or
// its auth scheme, so BASE_URL below and the Bearer-token shape are INFERRED
// from that operator-API convention, not confirmed against a live reader
// account. Verify both against the credential email before relying on this
// in production — see integrations/ev-charging/manifest.json's `pl-eipa-api-key`
// setup notes.
const BASE_URL = "https://eipa.udt.gov.pl/reader/api";

export const PL_EIPA_STATION_URL = `${BASE_URL}/station.json`;
export const PL_EIPA_POINT_URL = `${BASE_URL}/point.json`;
export const PL_EIPA_DYNAMIC_URL = `${BASE_URL}/dynamic.json`;
export const PL_EIPA_POOL_URL = `${BASE_URL}/pool.json`;
export const PL_EIPA_OPERATOR_URL = `${BASE_URL}/operator.json`;
export const PL_EIPA_DICTIONARY_URL = `${BASE_URL}/dictionary.json`;

/**
 * Same env-var-only contract as the parking UTMC/NSW/BahnPark feeds (see
 * integrations/parking/poi-sources.ts): the data-manager POI-ingest scanner
 * builds this header directly from the environment at fetch time, bypassing
 * the admin credential vault entirely (`ctx.config` isn't available inside
 * `resolveHeaders`/the parser's own secondary fetches). Returns `{}` when
 * unset so the upstream 401 surfaces in the ingest status instead of a
 * silent skip.
 */
export function plEipaAuthHeaders(): Record<string, string> {
  const key = process.env[integrationEnvVarName("ev-charging", "pl-eipa-api-key")];
  if (!key) return {};
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

const FETCH_TIMEOUT_MS = 30_000;

interface EipaEnvelope {
  data?: unknown[];
  generated?: string;
}

/** Unwraps an EIPA `{ data: [...], generated }` envelope to its `data` array. */
export function parseEipaEnvelope(buffer: Buffer): unknown[] {
  const parsed = JSON.parse(buffer.toString("utf-8")) as EipaEnvelope;
  return Array.isArray(parsed.data) ? parsed.data : [];
}

/**
 * Fetches one of the un-seeded EIPA reader files (everything but
 * station.json, which the data-manager fetch stage pre-fetches as the ingest
 * seed). Each file is a single unpaginated envelope — unlike OCPDB's paged
 * feed, one GET is enough. Returns `[]` (and logs) on any failure so a
 * transient outage on a secondary file degrades gracefully instead of
 * aborting the whole run.
 */
export async function fetchEipaFile(url: string, log: PoiSourceLogger): Promise<unknown[]> {
  try {
    const res = await globalThis.fetch(url, {
      headers: plEipaAuthHeaders(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error(`pl-eipa-client: HTTP ${res.status} fetching ${url}`);
      return [];
    }
    const { data } = await readBoundedBinaryResponse(res, {
      maxBytes: 64 * 1024 * 1024,
      fallbackContentType: "application/json",
      label: "Polish EIPA charging feed",
    });
    return parseEipaEnvelope(data);
  } catch (err) {
    log.error(`pl-eipa-client: fetch failed for ${url} (${(err as Error).message})`);
    return [];
  }
}
