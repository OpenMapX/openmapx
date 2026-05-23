import type { BBox, PoiSource } from "./types.js";

export * from "./types.js";

export const ALL_POI_SOURCES: readonly PoiSource[] = [];

export function getPoiSource(id: string): PoiSource | undefined {
  return ALL_POI_SOURCES.find((s) => s.id === id);
}

export function getPoiSourcesByDomain(domain: string): readonly PoiSource[] {
  return ALL_POI_SOURCES.filter((s) => s.domain === domain);
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const CRON_RE = /^[\d*/,-]+(\s+[\d*/,-]+){4}$/;

function checkBBox(id: string, bbox: BBox): string[] {
  const errors: string[] = [];
  const [west, south, east, north] = bbox;
  if (!(west < east))
    errors.push(`source "${id}": coverage west (${west}) must be < east (${east})`);
  if (!(south < north))
    errors.push(`source "${id}": coverage south (${south}) must be < north (${north})`);
  if (west < -180 || west > 180)
    errors.push(`source "${id}": coverage west (${west}) out of range [-180,180]`);
  if (east < -180 || east > 180)
    errors.push(`source "${id}": coverage east (${east}) out of range [-180,180]`);
  if (south < -90 || south > 90)
    errors.push(`source "${id}": coverage south (${south}) out of range [-90,90]`);
  if (north < -90 || north > 90)
    errors.push(`source "${id}": coverage north (${north}) out of range [-90,90]`);
  return errors;
}

export function validatePoiSourceRegistry(sources: readonly PoiSource[] = ALL_POI_SOURCES): void {
  const errors: string[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i] as PoiSource;
    const id = src.id;

    const prev = seen.get(id);
    if (prev !== undefined) {
      errors.push(`duplicate source id "${id}" at indexes ${prev} and ${i}`);
    } else {
      seen.set(id, i);
    }

    if (!ID_RE.test(id)) {
      errors.push(`source "${id}": id must match ${ID_RE} (table-name-safe)`);
    }

    const hasStatic = (src as { static?: unknown }).static !== undefined;
    const hasBundled = (src as { bundled?: unknown }).bundled !== undefined;
    const hasLive = (src as { live?: unknown }).live !== undefined;

    if (hasStatic && hasBundled) {
      errors.push(`source "${id}": cannot set both "static" and "bundled"`);
    } else if (!hasStatic && !hasBundled) {
      errors.push(`source "${id}": must set exactly one of "static" or "bundled"`);
    }

    if (hasLive && !hasStatic) {
      errors.push(`source "${id}": "live" requires "static" (not allowed with "bundled")`);
    }

    if (hasStatic) {
      const cron = (src as { static: { cron: string } }).static.cron;
      if (!CRON_RE.test(cron)) {
        errors.push(`source "${id}": static.cron "${cron}" is not a valid 5-field cron expression`);
      }
    }
    if (hasLive) {
      const cron = (src as { live: { cron: string } }).live.cron;
      if (!CRON_RE.test(cron)) {
        errors.push(`source "${id}": live.cron "${cron}" is not a valid 5-field cron expression`);
      }
    }
    if (hasBundled) {
      const cron = (src as { bundled: { cron: string } }).bundled.cron;
      if (!CRON_RE.test(cron)) {
        errors.push(
          `source "${id}": bundled.cron "${cron}" is not a valid 5-field cron expression`,
        );
      }
    }

    if (src.coverage) {
      errors.push(...checkBBox(id, src.coverage));
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `validatePoiSourceRegistry found ${errors.length} problem(s):\n  - ${errors.join("\n  - ")}`,
    );
  }
}
