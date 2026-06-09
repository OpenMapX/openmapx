"use client";

import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useGeocodingAttribution } from "@/lib/useGeocodingAttribution";

/**
 * Attribution for a place's core data — name, address, opening hours, and raw OSM
 * tags — which is produced by the active geocoding providers. Those are
 * overwhelmingly OpenStreetMap-based (Nominatim / Photon / Overpass / MapTiler),
 * and OSM's ODbL (plus other geocoder licenses) requires the credit to be visible
 * wherever the data is shown. Other parts of the panel carry their own credit
 * (knowledge facts, photos, and the data-source detail sections), so this only
 * covers the otherwise-uncredited core fields. Mirrors the geocoding credit the
 * search dropdown already shows (same `useGeocodingAttribution` hook).
 */
export function PlaceDataAttribution() {
  const tc = useTranslations("common");
  const html = useGeocodingAttribution();

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
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: trusted attribution HTML built from integration manifests */}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </Typography>
  );
}
