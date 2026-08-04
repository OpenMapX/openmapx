"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  createPlace,
  type LngLat,
  PANEL,
  type StreetLevelCapabilities,
  type StreetLevelImage,
  safeHref,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";

/** Capture month and year in the active locale, or null when unknown. */
export function formatCaptureDate(capturedAt: string | undefined, locale: string): string | null {
  if (!capturedAt) return null;
  const date = new Date(capturedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(locale, { month: "short", year: "numeric" });
}

export function StreetLevelInfoCard({
  image,
  provider,
  onClose,
}: {
  image: StreetLevelImage;
  provider: StreetLevelCapabilities;
  onClose: () => void;
}) {
  const t = useTranslations("streetLevel");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { flyTo } = useMap();
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setIsFocused = useSearchStore((s) => s.setIsFocused);

  // Apply immediately on the first image, debounce subsequent navigations by
  // 1s so arrowing quickly through a sequence doesn't spam the geocoder.
  // Depend on the scalar coordinates rather than the tuple: `image` is a fresh
  // object on every hop, so the array identity would retrigger constantly.
  const [debouncedLngLat, setDebouncedLngLat] = useState<LngLat | null>(null);
  const isFirstImage = useRef(true);
  const [lng, lat] = image.lngLat;

  useEffect(() => {
    const next: LngLat = [lng, lat];
    if (isFirstImage.current) {
      isFirstImage.current = false;
      setDebouncedLngLat(next);
      return;
    }
    const timer = setTimeout(() => setDebouncedLngLat(next), 1000);
    return () => clearTimeout(timer);
  }, [lng, lat]);

  const { data: reverseGeo } = useReverseGeocoding(debouncedLngLat);
  const captureDate = formatCaptureDate(image.capturedAt, locale);

  if (!reverseGeo && !captureDate) return null;

  const showOnMap = () => {
    if (debouncedLngLat && reverseGeo) {
      const label = reverseGeo.address;
      const address = [reverseGeo.address, reverseGeo.city].filter(Boolean).join(", ");
      setQuery(label);
      setIsFocused(false);
      flyTo(debouncedLngLat, 17);
      setSelectedPlace(
        createPlace({
          primaryScheme: "streetLevel",
          ids: { streetLevel: `${debouncedLngLat[0]},${debouncedLngLat[1]}` },
          name: label,
          address,
          coordinates: debouncedLngLat,
          category: "address",
        }),
      );
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    }
    onClose();
  };

  return (
    <Box
      sx={{
        position: "absolute",
        top: 80,
        left: 12,
        zIndex: 10,
        bgcolor: "rgba(30,30,30,0.9)",
        borderRadius: "12px",
        p: "12px 14px",
        minWidth: 260,
        maxWidth: 340,
        color: "#fff",
        backdropFilter: "blur(4px)",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
        <IconButton
          size="small"
          onClick={onClose}
          sx={{ color: "#fff", p: 0, mt: 0.3, flexShrink: 0 }}
          aria-label={tc("back")}
        >
          <ArrowBackIcon sx={{ fontSize: 20 }} />
        </IconButton>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            sx={{
              fontWeight: 700,
              fontSize: 15,
              lineHeight: 1.3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {reverseGeo?.address ?? t("unknownLocation")}
          </Typography>
          {reverseGeo?.city && (
            <Typography sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)", mt: 0.25 }}>
              {reverseGeo.city}
            </Typography>
          )}
        </Box>

        <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0, ml: 0.5 }}>
          <Box sx={{ width: "1px", height: 32, bgcolor: "rgba(255,255,255,0.25)", mr: 0.5 }} />
          <IconButton
            size="small"
            onClick={showOnMap}
            sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}
            aria-label={t("showOnMap")}
          >
            <PlaceIcon sx={{ fontSize: 19 }} />
          </IconButton>
          <IconButton
            size="small"
            sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}
            aria-label={t("moreOptions")}
          >
            <MoreVertIcon sx={{ fontSize: 19 }} />
          </IconButton>
        </Box>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1.25 }}>
        <Box
          sx={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            bgcolor: provider.color,
            flexShrink: 0,
          }}
        />
        <Typography sx={{ fontSize: 13 }}>{provider.name}</Typography>
      </Box>

      {image.author && (
        <Typography sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)", mt: 0.5 }}>
          {image.author}
        </Typography>
      )}

      <Divider sx={{ bgcolor: "rgba(255,255,255,0.2)", my: 1 }} />

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
        <Typography sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>
          {captureDate ?? ""}
        </Typography>
        {image.license && (
          <Link
            href={safeHref(image.licenseUrl ?? provider.licenseUrl)}
            target="_blank"
            rel="noopener noreferrer"
            sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}
          >
            {image.license}
          </Link>
        )}
      </Box>
    </Box>
  );
}
