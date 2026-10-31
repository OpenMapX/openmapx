import { creditLicensing, safeHref } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { contributorKey } from "@openmapx/mobility-core/contributors";
import {
  type AttributionLogo,
  DISPLAY_LICENSE_SCOPES,
  formatLicensing,
} from "@openmapx/mobility-core/licensing";

/**
 * How a credit reads and links wherever OpenMapX shows one: React credit
 * strips and the HTML of map popups share these rules, so a source looks and
 * behaves the same in a panel, a popup and the map credits.
 */

/** Required branding, from reviewed local assets, never provider image URLs. */
export const ATTRIBUTION_LOGO_ASSETS: Record<
  AttributionLogo,
  { src: string; darkSrc?: string; name: string; href: string }
> = {
  openweather: {
    src: "/attribution/openweather.png",
    darkSrc: "/attribution/openweather-white.png",
    name: "OpenWeather",
    href: "https://openweathermap.org/",
  },
  mapillary: { src: "/mapillary-logo.svg", name: "Mapillary", href: "https://www.mapillary.com/" },
  maptiler: {
    src: "/attribution/maptiler.svg",
    name: "MapTiler",
    href: "https://www.maptiler.com/",
  },
  tdx: { src: "/attribution/tdx.png", name: "TDX", href: "https://tdx.transportdata.tw/" },
};

/** The external credit URL when safe to follow, or the in-app licenses anchor. */
export function creditHref(attr: Attribution): { href: string; external: boolean } {
  const external = safeHref(attr.url);
  if (external) return { href: external, external: true };
  return { href: `/licenses#source-${encodeURIComponent(attr.sourceId)}`, external: false };
}

/**
 * Longest license that still reads as a chip suffix. Identifiers and short
 * labels ("CC-BY-4.0", "NLOD 2.0", "U.S. Public Domain") fit; qualified
 * descriptions ("Mixed (per upstream GTFS/GBFS feed; mostly open data)") move
 * to the full credit instead of stretching the chip across the panel.
 */
const MAX_CHIP_LICENSE_LENGTH = 24;

/** A receipt's licence as a short label, or undefined without licensing. */
export function creditLicense(attr: Attribution): string | undefined {
  const licensing = attr.licensing && creditLicensing(attr.licensing);
  return licensing
    ? formatLicensing(licensing, { scopes: DISPLAY_LICENSE_SCOPES }) || undefined
    : undefined;
}

/** "Source · Licence" where the licence fits a chip, else the source alone. */
export function creditLabel(attr: Attribution): string {
  const text = creditLicense(attr);
  return text && text.length <= MAX_CHIP_LICENSE_LENGTH ? `${attr.name} · ${text}` : attr.name;
}

/** Collapse identical displayed receipts, preserving every distinct required notice. */
export function dedupeCreditsForDisplay(attributions: readonly Attribution[]): Attribution[] {
  const seen = new Set<string>();
  return attributions.filter((receipt) => {
    if (!receipt?.sourceId) return false;
    // Multiple feeds can credit the same agency. Their full credit, links and
    // license must match before one presentation can discharge both receipts.
    const key = contributorKey({ ...receipt, sourceId: "" });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
