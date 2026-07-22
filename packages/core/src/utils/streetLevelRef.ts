import type { StreetLevelRef } from "../types/streetLevel";

const SEPARATOR = ":";

export function formatStreetLevelRef(ref: StreetLevelRef): string {
  return `${ref.providerId}${SEPARATOR}${ref.imageId}`;
}

/**
 * Parse a street-level-imagery reference. Image ids may themselves contain colons, so
 * only the first separator is significant.
 *
 * `fallbackProviderId` exists for legacy `?sv=<mapillaryId>` deep links that
 * predate provider qualification.
 */
export function parseStreetLevelRef(
  raw: string,
  fallbackProviderId?: string,
): StreetLevelRef | null {
  if (!raw) return null;

  const separatorIndex = raw.indexOf(SEPARATOR);
  if (separatorIndex === -1) {
    return fallbackProviderId ? { providerId: fallbackProviderId, imageId: raw } : null;
  }

  const providerId = raw.slice(0, separatorIndex);
  const imageId = raw.slice(separatorIndex + 1);
  if (!providerId || !imageId) return null;

  return { providerId, imageId };
}
