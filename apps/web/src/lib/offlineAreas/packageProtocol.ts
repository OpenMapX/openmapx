import type { OfflinePackageResolver } from "./packageResolver";

const PROTOCOL = "pmtiles";
const URL_PATTERN = /^pmtiles:\/\/offline\/([^/]+)\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/;
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
  removeProtocol?(name: string): void;
}

export function registerOfflinePmtilesProtocol(
  maplibre: ProtocolMaplibre,
  resolver: OfflinePackageResolver,
): () => void {
  const existing = registrations.get(maplibre as object);
  if (existing) {
    existing.resolver = resolver;
    return () => {};
  }
  const registration = {
    resolver,
    handler: async (parameters: { url: string }) => {
      const match = URL_PATTERN.exec(parameters.url);
      if (!match) throw new OfflineCoverageError("invalid offline PMTiles URL");
      const [, packageId, zoomValue, xValue, yValue] = match;
      const reader = await registration.resolver.openReader(packageId);
      const tile = await reader.tile(Number(zoomValue), Number(xValue), Number(yValue));
      if (!tile)
        throw new OfflineCoverageError(`offline package ${packageId} does not contain this tile`);
      return { data: toArrayBuffer(tile) };
    },
  };
  maplibre.addProtocol(PROTOCOL, registration.handler);
  registrations.set(maplibre as object, registration);
  return () => {
    maplibre.removeProtocol?.(PROTOCOL);
    registrations.delete(maplibre as object);
  };
}

export function offlinePmtilesTileUrl(packageId: string): string {
  return `pmtiles://offline/${packageId}/{z}/{x}/{y}`;
}
