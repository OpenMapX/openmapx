"use client";

import Typography from "@mui/material/Typography";
import { buildAttributionHtml } from "@openmapx/core";
import type { Licensing } from "@openmapx/mobility-core/licensing";
import { AttributionText } from "./AttributionText";

export interface SectionAttributionProps {
  /** Source name (e.g. "Cambio CarSharing"). */
  name: string;
  /** Optional canonical URL the name links to. */
  url?: string;
  /** Optional license string (e.g. "Datenlizenz Deutschland Zero 2.0"). */
  licensing?: Licensing;
  /** Optional URL the license string links to. */
  /**
   * Optional verbatim attribution HTML from the integration manifest. When set,
   * it overrides the default `© name (license)` form — e.g. a licence-mandated
   * wording, or a public-domain source that must not carry a `©`.
   */
  attribution?: string;
}

/**
 * Standardised one-line attribution for place-panel sections. Renders through
 * the shared `buildAttributionHtml` builder — the single place the `©`/format
 * and any manifest `attribution` override are applied — so no section
 * hand-assembles its own credit or hardcodes a `©`.
 */
export function SectionAttribution({ name, url, licensing, attribution }: SectionAttributionProps) {
  if (!name) return null;
  const html = buildAttributionHtml({
    name,
    url: url ?? "",
    licensing,
    attribution,
  });
  return (
    <Typography
      variant="caption"
      component="div"
      sx={{ color: "text.secondary", mt: 0.5, display: "block" }}
    >
      <AttributionText html={html} />
    </Typography>
  );
}
