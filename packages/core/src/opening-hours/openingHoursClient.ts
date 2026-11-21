// Client-safe opening-hours helpers.
//
// These helpers operate purely on the precomputed `OpeningHoursInfo` that the
// API returns (see `buildOpeningHoursInfo` in `./openingHours.ts`). They do
// not import the LGPL-3 `opening_hours` library, so they are safe to bundle
// into the browser.

import type { OpeningHoursInfo } from "../types/openingHoursInfo";
import type { OpeningHoursSource } from "./openingHoursSource";

/**
 * Returns whether the precomputed weekly bitmap shows the place as open at
 * the given day-of-week and hour-of-day in local time. Falls back to `false`
 * when the bitmap is missing or malformed.
 */
export function isOpenAtBitmap(
  weekBitmap: string | undefined,
  dayIdx: number,
  hour: number,
): boolean {
  if (!weekBitmap) return false;
  if (dayIdx < 0 || dayIdx > 6 || hour < 0 || hour > 23) return false;
  const bitIdx = dayIdx * 24 + hour;
  const byteIdx = bitIdx >> 3;
  if (byteIdx >= weekBitmap.length / 2) return false;
  const byte = Number.parseInt(weekBitmap.substring(byteIdx * 2, byteIdx * 2 + 2), 16);
  if (!Number.isFinite(byte)) return false;
  const bitInByte = 7 - (bitIdx & 7); // MSB-first, matches builder
  return (byte & (1 << bitInByte)) !== 0;
}

/**
 * Resolves "open at <day, hour>" against a precomputed week bitmap. When both
 * `day` and `hour` are null, returns true (no constraint).
 */
export function isOpenAtSlot(
  info: OpeningHoursInfo | undefined,
  day: number | null,
  hour: number | null,
): boolean {
  if (!info) return false;
  // When the user only picks a day or only a time, match the existing
  // server-side behavior: fall back to the current day/hour for the unset side.
  const now = new Date();
  const dayIdx = day ?? now.getDay();
  const hourIdx = hour ?? now.getHours();
  return isOpenAtBitmap(info.weekBitmap, dayIdx, hourIdx);
}
/** A stale calculated verdict is neutral even when raw hours remain cached. */
export function presentOpeningHoursInfo(
  info: OpeningHoursInfo | undefined,
  raw: string | undefined,
  now = Date.now(),
): OpeningHoursInfo | undefined {
  if (!raw) return undefined;
  const expiry = info?.validUntil ? Date.parse(info.validUntil) : Number.NaN;
  if (info && Number.isFinite(expiry) && expiry > now) return info;
  return {
    status: { isOpen: false, isUnknown: true, text: raw },
    isAlwaysOpen: false,
    weekBitmap: "",
  };
}

/** Pair the chosen raw schedule with only matching status and source records. */
export function matchingOpeningHours(
  raw: string | undefined,
  candidates: ReadonlyArray<
    | {
        openingHours?: string;
        openingHoursInfo?: OpeningHoursInfo;
        openingHoursSource?: OpeningHoursSource;
      }
    | null
    | undefined
  >,
  now = Date.now(),
): { info?: OpeningHoursInfo; source?: OpeningHoursSource } {
  const info = candidates.find(
    (candidate) => candidate?.openingHours === raw && candidate?.openingHoursInfo,
  )?.openingHoursInfo;
  const source = candidates.find(
    (candidate) => candidate?.openingHours === raw && candidate?.openingHoursSource,
  )?.openingHoursSource;
  return { info: presentOpeningHoursInfo(info, raw, now), source };
}

/** Project active list results before hours filters and presentation. */
export function presentCategoryOpeningHours<
  T extends { openingHours?: string; openingHoursInfo?: OpeningHoursInfo },
>(results: T[], now = Date.now()): T[] {
  return results.map((place) =>
    place.openingHours
      ? {
          ...place,
          openingHoursInfo: presentOpeningHoursInfo(
            place.openingHoursInfo,
            place.openingHours,
            now,
          ),
        }
      : place,
  );
}
