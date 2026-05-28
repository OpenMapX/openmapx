/**
 * Open-data license normalization + canonical URL resolution.
 *
 * Data feeds describe their license inconsistently: some give an SPDX-style
 * id (`ODbL-1.0`), some a verbose human label ("Datenlizenz Deutschland –
 * Namensnennung – Version 2.0"), some only a URL, some nothing. This module
 * collapses those into a single `{ label, url? }` so the UI can render one
 * clickable license link no matter which form the upstream provided.
 *
 * The SPDX-id → canonical-URL leg is delegated to the `spdx-license-list`
 * package (the full SPDX registry, including the open-data licenses we serve
 * such as ODbL-1.0, DL-DE-BY-2.0, NLOD-2.0). The verbose-label → SPDX-id leg
 * below is OpenMapX-specific: no package maps free-text labels like
 * "Datenlizenz Deutschland – Namensnennung – Version 2.0" back to their id,
 * so we keep a small alias table for the forms our feeds actually emit.
 */

import spdxLicenseList from "spdx-license-list";

/**
 * Verbose / aliased license labels → SPDX. Keys are lower-cased and matched
 * loosely (substring) so minor punctuation variations still resolve. Order
 * matters: more specific patterns first.
 */
const LABEL_TO_SPDX: Array<{ match: string; spdx: string }> = [
  // Datenlizenz Deutschland
  { match: "datenlizenz deutschland", spdx: "DL-DE-BY-2.0" }, // "Namensnennung" variant is the common one
  { match: "dl-de/by", spdx: "DL-DE-BY-2.0" },
  { match: "dl-de/zero", spdx: "DL-DE-ZERO-2.0" },
  // Creative Commons
  { match: "publicdomain/zero", spdx: "CC0-1.0" },
  { match: "cc0", spdx: "CC0-1.0" },
  { match: "cc 0 1.0", spdx: "CC0-1.0" }, // MobiData BW's literal label
  { match: "cc-0", spdx: "CC0-1.0" },
  { match: "by-sa/4.0", spdx: "CC-BY-SA-4.0" },
  { match: "by-sa 4.0", spdx: "CC-BY-SA-4.0" },
  { match: "namensnennung - weitergabe unter gleichen bedingungen 4.0", spdx: "CC-BY-SA-4.0" },
  { match: "by-sa/3.0", spdx: "CC-BY-SA-3.0" },
  { match: "by/4.0", spdx: "CC-BY-4.0" },
  { match: "by 4.0", spdx: "CC-BY-4.0" },
  { match: "namensnennung - 4.0", spdx: "CC-BY-4.0" },
  { match: "namensnennung 4.0", spdx: "CC-BY-4.0" },
  { match: "by/3.0", spdx: "CC-BY-3.0" },
  // Open Data Commons
  { match: "opendatacommons.org/licenses/odbl", spdx: "ODbL-1.0" },
  { match: "open database license", spdx: "ODbL-1.0" },
  { match: "odbl", spdx: "ODbL-1.0" },
  { match: "opendatacommons.org/licenses/by", spdx: "ODC-By-1.0" },
  // Norway
  { match: "norwegian licence for open government data", spdx: "NLOD-2.0" },
  { match: "data.norge.no/nlod", spdx: "NLOD-2.0" },
  // Apache
  { match: "apache.org/licenses/license-2.0", spdx: "Apache-2.0" },
  { match: "apache license 2.0", spdx: "Apache-2.0" },
];

/**
 * Best-effort SPDX identifier for a raw license string or URL. Returns the
 * input unchanged if it's already a known SPDX id, else maps via the alias
 * table, else `undefined`.
 */
export function normalizeLicenseToSpdx(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Already a valid SPDX id — resolve to its canonical casing.
  const canonical = canonicalSpdxId(trimmed);
  if (canonical) return canonical;
  const lower = trimmed.toLowerCase();
  for (const { match, spdx } of LABEL_TO_SPDX) {
    if (lower.includes(match)) return spdx;
  }
  return undefined;
}

/** Resolve a (possibly mis-cased) string to its canonical SPDX id, if valid. */
function canonicalSpdxId(value: string): string | undefined {
  if (Object.hasOwn(spdxLicenseList, value)) return value;
  const lower = value.toLowerCase();
  for (const id of Object.keys(spdxLicenseList)) {
    if (id.toLowerCase() === lower) return id;
  }
  return undefined;
}

/** Canonical license-text URL for a known SPDX identifier, if any. */
export function licenseUrlForSpdx(spdx: string | undefined): string | undefined {
  if (!spdx) return undefined;
  const id = canonicalSpdxId(spdx);
  return id ? spdxLicenseList[id]?.url : undefined;
}

export interface ResolvedLicenseLink {
  /** Display label — the SPDX id when resolvable, else the raw license text. */
  label: string;
  /** Canonical license-text URL, when one can be determined. */
  url?: string;
}

/**
 * Resolve a displayable license link from whatever a feed provided.
 *
 * Resolution order for the URL:
 *   1. an explicit `licenseUrl` (the feed told us exactly where the terms are)
 *   2. the canonical URL for the SPDX id derived from `spdx` or `license`
 *
 * The label prefers the SPDX short form (`ODbL-1.0`) when we can derive one,
 * otherwise falls back to the raw license string. Returns `null` when there's
 * nothing to show (no license + no url).
 */
export function resolveLicenseLink(input: {
  license?: string;
  licenseUrl?: string;
  spdx?: string;
}): ResolvedLicenseLink | null {
  const rawLicense = input.license?.trim() || undefined;
  const explicitUrl = input.licenseUrl?.trim() || undefined;
  const spdx =
    input.spdx?.trim() || normalizeLicenseToSpdx(rawLicense) || normalizeLicenseToSpdx(explicitUrl);

  const label = spdx ?? rawLicense;
  if (!label && !explicitUrl) return null;

  const url = explicitUrl ?? licenseUrlForSpdx(spdx);
  return { label: label ?? "License", url };
}
