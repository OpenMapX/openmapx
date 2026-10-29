"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import { useTheme } from "@mui/material/styles";
import { safeHref } from "@openmapx/core";
import type { VisibleAttribution } from "@openmapx/core/attribution";
import type { AttributionLogo } from "@openmapx/mobility-core/licensing";
import { AttributionText } from "./AttributionText";

const LOGOS: Record<AttributionLogo, { src: string; name: string; href: string }> = {
  openweather: {
    src: "/attribution/openweather.png",
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

/** Required branding comes from reviewed local assets, never provider image URLs. */
export function AttributionLogos({ logos }: { logos: readonly AttributionLogo[] }) {
  const theme = useTheme();
  return [...new Set(logos)].map((id) => {
    const logo = LOGOS[id];
    return (
      <Link
        key={id}
        onClick={(event) => event.stopPropagation()}
        href={safeHref(logo.href)}
        target="_blank"
        rel="noopener noreferrer"
        sx={{ display: "inline-flex", verticalAlign: "middle", mx: 0.5 }}
      >
        <Box
          component="img"
          src={
            id === "openweather" && theme.palette.mode === "dark"
              ? "/attribution/openweather-white.png"
              : logo.src
          }
          alt={logo.name}
          sx={{ height: "18px", width: "auto", maxWidth: "100%", objectFit: "contain" }}
        />
      </Link>
    );
  });
}

/** Permanent notices never use ellipsis, clipping, or a hidden scrolling area. */
export function AttributionNotices({ notices }: { notices: readonly VisibleAttribution[] }) {
  // Callers normally group identical notices. Still render duplicate inputs
  // faithfully, without orphaning DOM nodes when another credit is inserted.
  const occurrences = new Map<string, number>();
  return notices.map((notice, index) => {
    const occurrence = occurrences.get(notice.html) ?? 0;
    occurrences.set(notice.html, occurrence + 1);
    return (
      <Box
        key={JSON.stringify([notice.html, occurrence])}
        component="span"
        sx={{
          overflowWrap: "anywhere",
          ...(notice.prominence === "normal" ? { fontSize: "1rem", lineHeight: 1.4 } : {}),
        }}
      >
        {index > 0 && " | "}
        <AttributionText html={notice.html} />
        <AttributionLogos logos={notice.logos} />
      </Box>
    );
  });
}
