import type { Wgs84BoundingBox } from "@openmapx/integration-framework";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import type { EnturClient } from "../client";
import { EnturRequestError } from "../errors";
import type { EnturGeocoderFeature, EnturGeocoderPolicy, EnturGeocoderSource } from "./client";

export const ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS = Object.freeze({
  nsr: "entur-geocoder-nsr",
  openstreetmap: "entur-geocoder-osm",
  "kartverket-matrikkelenadresse": "entur-geocoder-kartverket-addresses",
  "kartverket-stedsnavn": "entur-geocoder-kartverket-place-names",
  "custom-poi": "entur-geocoder-custom-poi",
} as const satisfies Record<EnturGeocoderSource, string>);
const suppliers = Object.keys(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS) as EnturGeocoderSource[];

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Only these native namespaces prove a single supplier in the reviewed v3 contract. */
function lookupSupplier(id: string): EnturGeocoderSource | undefined {
  if (/^NSR:(StopPlace|GroupOfStopPlaces):[^:]+$/.test(id)) return "nsr";
  if (/^OSM:TopographicPlace:[^:]+$/.test(id)) return "openstreetmap";
  if (/^KVE:PostalAddress:[^:]+$/.test(id)) return "kartverket-matrikkelenadresse";
  if (/^KVE:PlaceName:[^:]+$/.test(id)) return "kartverket-stedsnavn";
  return undefined;
}

export type EnturGeocoderSources = EnturGeocoderPolicy & {
  contributorsFor(feature: EnturGeocoderFeature): readonly Attribution[];
};

export function createEnturGeocoderSources(options: {
  contributors: EnturClient["contributors"];
  isSourceAllowed: (sourceId: string) => Promise<boolean>;
}): EnturGeocoderSources {
  const catalogue: Record<string, readonly Attribution[]> = Object.create(null);
  for (const [sourceId, receipts] of Object.entries(options.contributors))
    catalogue[sourceId] = freeze(structuredClone(receipts) as Attribution[]);
  freeze(catalogue);
  const declared = suppliers.filter((source) =>
    Object.hasOwn(catalogue, ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source]),
  );
  const isSourceAllowed = options.isSourceAllowed;
  const receipts = new Map(
    declared.map((source) => [
      source,
      freeze(
        snapshotContributors(
          catalogue["entur-geocoder"] ?? [],
          catalogue[ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source]],
        ),
      ),
    ]),
  );
  return Object.freeze({
    async allowedSources(signal: AbortSignal) {
      const allowed: EnturGeocoderSource[] = [];
      for (const source of declared) {
        signal.throwIfAborted();
        if (
          await bounded(
            Promise.resolve().then(() =>
              isSourceAllowed(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS[source]),
            ),
            signal,
          )
        )
          allowed.push(source);
      }
      return Object.freeze(allowed);
    },
    async assertLookupAllowed(
      ids: readonly string[],
      allowed: readonly EnturGeocoderSource[],
      signal: AbortSignal,
    ) {
      signal.throwIfAborted();
      for (const id of ids) {
        const supplier = lookupSupplier(id);
        const possible = supplier ? [supplier] : suppliers;
        if (possible.some((source) => !declared.includes(source) || !allowed.includes(source)))
          throw new EnturRequestError("policy");
      }
    },
    contributorsFor(feature: EnturGeocoderFeature) {
      const captured = receipts.get(feature.properties.source);
      if (!captured) throw new EnturRequestError("policy");
      return captured;
    },
  });
}

export function normalizeEnturGeocoderCountry(input: unknown): string {
  if (input === undefined) return "no";
  if (input === "" || (typeof input === "string" && /^[a-z]{2}$/.test(input))) return input;
  throw new EnturRequestError("config");
}

/** Return detached country coverage; callers cannot mutate another generation's bounds. */
export function enturGeocoderCoverage(country: string): Wgs84BoundingBox | undefined {
  if (country === "no") return [4, 57.5, 32, 72];
  if (country === "se") return [10.5, 55, 24.5, 69.5];
  return undefined;
}
