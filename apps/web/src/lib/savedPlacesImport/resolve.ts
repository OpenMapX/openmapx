import {
  API_ENDPOINTS,
  ApiClientError,
  apiClient,
  haversineDistance,
  type SearchResult,
} from "@openmapx/core";
import { captureSavedPlaceContributors } from "@openmapx/core/saved-place-contributors";
import type { ImportList, ImportPlace } from "./types";
import { validCoordinates } from "./types";

interface ResolveOptions {
  lang?: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** A large import outruns the API's per-client geocoding budget; how often one lookup waits for it. */
const MAX_RATE_LIMIT_WAITS = 5;
const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

function sleep(seconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, seconds * 1000);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Geocodes one import entry. A 429 waits for the advertised `Retry-After` and
 * asks again, so a long list is slowed to the API's budget instead of having
 * its tail marked unresolved; any other failure resolves to no candidates.
 */
async function geocodeEntry(
  params: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<SearchResult[]> {
  for (let waits = 0; ; waits += 1) {
    try {
      return await apiClient.get<SearchResult[]>(API_ENDPOINTS.geocode, params, { signal });
    } catch (error) {
      signal?.throwIfAborted();
      if (
        !(error instanceof ApiClientError) ||
        error.status !== 429 ||
        waits >= MAX_RATE_LIMIT_WAITS
      ) {
        return [];
      }
      const seconds = Math.min(MAX_RATE_LIMIT_WAIT_SECONDS, error.retryAfterSeconds ?? 1);
      await sleep(Math.max(1, seconds), signal);
    }
  }
}
function tokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}
function plausible(query: string, candidate: string): boolean {
  const wanted = new Set(tokens(query));
  const actual = new Set(tokens(candidate));
  if (!wanted.size) return false;
  if ([...wanted].some((token) => /\p{N}/u.test(token) && !actual.has(token))) return false;
  return [...wanted].filter((token) => actual.has(token)).length / wanted.size >= 0.75;
}
function matches(place: ImportPlace, result: SearchResult, hinted: boolean): boolean {
  const [lng, lat] = result.coordinates;
  if (!validCoordinates(lat, lng)) return false;
  const candidateName =
    place.name === place.address ? result.address || result.label : result.name || result.label;
  if (!plausible(place.name, candidateName)) return false;

  if (hinted)
    return (
      haversineDistance([place.lng as number, place.lat as number], result.coordinates) <= 2000
    );
  return Boolean(place.address && result.address && plausible(place.address, result.address));
}

/** Lookups use only the configured host API; feature IDs never become place identities. */
export async function resolveImportPlaces(
  lists: readonly ImportList[],
  options: ResolveOptions = {},
): Promise<ImportList[]> {
  const resolved = lists.map((list) => ({
    ...list,
    places: list.places.map((place) => ({ ...place })),
  }));
  const pending = resolved
    .flatMap((list) => list.places)
    .filter((place) => place.status === "approximate" || place.status === "needsLookup");
  const queries = new Map<
    string,
    { places: ImportPlace[]; query: string; hint?: { lat: string; lng: string } }
  >();
  for (const place of pending) {
    const query =
      place.address && place.address !== place.name
        ? `${place.name}, ${place.address}`
        : place.name;
    const hint =
      place.status === "approximate"
        ? { lat: (place.lat as number).toFixed(2), lng: (place.lng as number).toFixed(2) }
        : undefined;
    const key = JSON.stringify([query, hint]);
    const entry = queries.get(key) || { places: [], query, hint };
    entry.places.push(place);
    queries.set(key, entry);
  }
  const work = [...queries.values()];
  let next = 0;
  let done = 0;
  options.onProgress?.(0, pending.length);
  async function worker() {
    while (next < work.length) {
      options.signal?.throwIfAborted();
      const entry = work[next++];
      const results = await geocodeEntry(
        { q: entry.query, ...(options.lang ? { lang: options.lang } : {}), ...entry.hint },
        options.signal,
      );
      options.signal?.throwIfAborted();
      for (const place of entry.places) {
        const candidates = entry.hint ? results : results.slice(0, 1);
        const match = candidates.find((result) => matches(place, result, Boolean(entry.hint)));
        if (match) {
          place.lat = match.coordinates[1];
          place.lng = match.coordinates[0];
          place.status = "located";
          place.geocoder = match;
          const { lat: _lat, lng: _lng, ...retained } = place.fieldContributors ?? {};
          const captured = captureSavedPlaceContributors(match, ["lat", "lng"]);
          place.fieldContributors = { ...retained, ...captured };
        } else if (place.status === "needsLookup") place.status = "unresolved";
        options.onProgress?.(++done, pending.length);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, work.length) }, worker));
  options.signal?.throwIfAborted();
  return resolved;
}
