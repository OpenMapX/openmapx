import type { OfflinePackageResolver } from "./packageResolver";

const PROTOCOL = "pmtiles";
const PACKAGE_ID = "omp2-[0-9a-f]{64}";
const PACKAGE_ID_PATTERN = new RegExp(`^${PACKAGE_ID}$`);
const URL_PATTERN = new RegExp(
  `^pmtiles://offline/(${PACKAGE_ID}(?:,${PACKAGE_ID})*)/(\\d+)/(\\d+)/(\\d+)(?:\\?.*)?$`,
);
const registrations = new WeakMap<
  object,
  {
    resolver: OfflinePackageResolver;
    handler: (parameters: { url: string }) => Promise<{ data: ArrayBuffer }>;
  }
>();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

export class OfflineCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfflineCoverageError";
  }
}

interface ProtocolMaplibre {
  addProtocol(name: string, handler: unknown): void;
}

/**
 * Install MapLibre's process-wide protocol once and keep its resolver current.
 * Protocols belong to the MapLibre module, not to an individual Map instance;
 * removing one when a preview unmounts would also break the main map.
 */
export function registerOfflinePmtilesProtocol(
  maplibre: ProtocolMaplibre,
  resolver: OfflinePackageResolver,
): void {
  const existing = registrations.get(maplibre as object);
  if (existing) {
    existing.resolver = resolver;
    return;
  }
  const registration = {
    resolver,
    handler: async (parameters: { url: string }) => {
      const match = URL_PATTERN.exec(parameters.url);
      if (!match) throw new OfflineCoverageError("invalid offline PMTiles URL");
      const [, packageSet, zoomValue, xValue, yValue] = match;
      let lastError: unknown;
      for (const packageId of packageSet.split(",")) {
        try {
          const reader = await registration.resolver.openReader(packageId);
          const tile = await reader.tile(Number(zoomValue), Number(xValue), Number(yValue));
          if (tile) return { data: toArrayBuffer(tile) };
        } catch (error) {
          lastError = error;
        }
      }
      throw new OfflineCoverageError(
        lastError
          ? `offline packages ${packageSet} could not read this tile: ${lastError instanceof Error ? lastError.message : String(lastError)}`
          : `offline packages ${packageSet} do not contain this tile`,
      );
    },
  };
  maplibre.addProtocol(PROTOCOL, registration.handler);
  registrations.set(maplibre as object, registration);
}

export function offlinePmtilesTileUrl(packageIds: readonly string[]): string {
  if (packageIds.length === 0 || packageIds.some((id) => !PACKAGE_ID_PATTERN.test(id))) {
    throw new Error("invalid offline package set");
  }
  return `pmtiles://offline/${[...new Set(packageIds)].join(",")}/{z}/{x}/{y}`;
}
