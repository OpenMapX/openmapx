import type { StreetLevelRef } from "../types/streetLevel";

const SEPARATOR = ":";

export function formatStreetLevelRef(ref: StreetLevelRef): string {
  return `${ref.providerId}${SEPARATOR}${ref.imageId}`;
}

/**
 * Parse a street-level-imagery reference. Image ids may themselves contain colons, so
 * only the first separator is significant.
 */
export function parseStreetLevelRef(raw: string): StreetLevelRef | null {
  if (!raw) return null;

  const separatorIndex = raw.indexOf(SEPARATOR);
  if (separatorIndex === -1) return null;

  const providerId = raw.slice(0, separatorIndex);
  const imageId = raw.slice(separatorIndex + 1);
  if (!providerId || !imageId) return null;

  return { providerId, imageId };
}
