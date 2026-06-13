"use client";

import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { buildPlaceCoreAttribution } from "@/lib/placeCoreAttribution";

/**
 * Attribution for a place's core data — name, address, opening hours, and raw
 * OSM tags. The credit is derived from the place itself (see
 * {@link buildPlaceCoreAttribution}) so each place is credited only to the
 * source that produced it: OSM-backed places show the ODbL OpenStreetMap
 * credit, while transit-stop places are credited by the transit section
 * instead of having every installed geocoder's source listed here. Other
 * parts of the panel (knowledge facts, photos, data-source detail sections)
 * carry their own credit.
 */
export function PlaceDataAttribution({ place }: { place: Place }) {
  const tc = useTranslations("common");
  const html = buildPlaceCoreAttribution(place);

  if (!html) return null;

  return (
    <Typography
      variant="caption"
      component="div"
      sx={{
        px: 2,
        py: 1.25,
        color: "text.secondary",
        "& a": { color: "inherit", textDecoration: "underline" },
      }}
    >
      {tc("data")}:{" "}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted attribution HTML built from a fixed OSM credit string */}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </Typography>
  );
}
