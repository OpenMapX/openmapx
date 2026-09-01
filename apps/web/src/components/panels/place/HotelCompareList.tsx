"use client";

import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import VerifiedIcon from "@mui/icons-material/Verified";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import {
  bareDomain,
  buildHotelOpenUrl,
  type HotelProviderInfo,
  type Place,
  safeHref,
  useHotelSearchStore,
  useOfficialBookingUrl,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { BrandMark } from "../shared/BrandMark";

function Row({
  onClick,
  mark,
  primary,
  secondary,
}: {
  onClick: () => void;
  mark: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
}) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        py: 1.25,
        px: 1,
        mx: -1,
        borderRadius: 1.5,
        cursor: "pointer",
        "&:hover": { bgcolor: "action.hover" },
      }}
    >
      {mark}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {primary}
        </Typography>
        {secondary && (
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {secondary}
          </Typography>
        )}
      </Box>
      <OpenInNewIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
    </Box>
  );
}

/**
 * "All options" compare list for a lodging place. Renders an Official-site row
 * (place.website) when present, then the region-filtered OTAs. Each opens the
 * provider's pre-filled search via the backend hand-off. Mirrors the food
 * delivery provider list. Shows no prices (deep-link only).
 */
export function HotelCompareList({
  place,
  providers,
  countryCode,
}: {
  place: Place;
  providers: HotelProviderInfo[];
  countryCode?: string;
}) {
  const t = useTranslations("place");
  const { checkIn, checkOut, adults, rooms } = useHotelSearchStore();

  const { data: officialUrl } = useOfficialBookingUrl(
    { name: place.name, website: place.website, checkIn, checkOut, adults, rooms },
    Boolean(place.website),
  );

  const openProvider = (id: string) => {
    const [lng, lat] = place.coordinates;
    const url = buildHotelOpenUrl(id, {
      name: place.name,
      city: place.city,
      countryCode,
      lat,
      lng,
      address: place.address,
      checkIn,
      checkOut,
      adults,
      rooms,
      wikidata: place.osmTags?.wikidata,
    });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const openOfficial = () => {
    const dest = safeHref(officialUrl ?? place.website);
    if (dest) window.open(dest, "_blank", "noopener,noreferrer");
  };

  return (
    <Box>
      {place.website && (
        <Row
          onClick={openOfficial}
          mark={<VerifiedIcon sx={{ fontSize: 28, color: BRAND, flexShrink: 0 }} />}
          primary={place.name}
          secondary={officialUrl ? t("officialSiteDated") : t("officialSite")}
        />
      )}
      {providers.map((p) => (
        <Row
          key={p.id}
          onClick={() => openProvider(p.id)}
          mark={<BrandMark branding={{ name: p.name, color: p.color }} size={28} />}
          primary={p.name}
          secondary={p.domain || bareDomain(p.homepage)}
        />
      ))}
    </Box>
  );
}
