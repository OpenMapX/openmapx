"use client";

import LaunchIcon from "@mui/icons-material/Launch";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  safeHref,
  useBrandDetail,
  useBrandLogoAttribution,
  useCategorySearchStore,
} from "@openmapx/core";
import { BrandLogo } from "@/components/search/BrandLogo";

/**
 * Identity strip above the results when the Explore list is showing one chain.
 *
 * The name and description come from the store so the card paints immediately
 * on selection; the detail query only adds the website, which arrives late
 * without shifting the layout. Per-logo Commons attribution (author, licence)
 * resolves later still and just as silently — see `useBrandLogoAttribution`.
 * The 36px logo here is the one place a brand mark is shown at size; tiny
 * map/list icons rely on the blanket NSI/Commons registry credit instead.
 */
export function BrandHeaderCard() {
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const { data: detail } = useBrandDetail(activeBrand?.qid ?? null);
  const { data: attribution } = useBrandLogoAttribution(
    activeBrand?.qid ?? null,
    Boolean(activeBrand?.logoFile),
  );

  if (!activeBrand) return null;

  const description = activeBrand.description ?? detail?.description;
  const website = safeHref(detail?.website);
  const authorUrl = safeHref(attribution?.authorUrl);
  const licenseUrl = safeHref(attribution?.licenseUrl);
  const linkSx = {
    color: "text.secondary",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, currentColor 40%, transparent)",
    "&:hover": { textDecorationColor: "currentColor" },
  } as const;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1.5,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <BrandLogo brand={activeBrand} size={36} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography sx={{ fontSize: 15, fontWeight: 500 }} noWrap>
          {activeBrand.name}
        </Typography>
        {description && (
          <Typography sx={{ fontSize: 12, color: "text.secondary" }} noWrap>
            {description}
          </Typography>
        )}
        {(attribution?.author || attribution?.license) && (
          <Typography sx={{ fontSize: 11, color: "text.secondary" }} noWrap>
            {attribution.author &&
              (authorUrl ? (
                <Link href={authorUrl} target="_blank" rel="noopener noreferrer" sx={linkSx}>
                  {attribution.author}
                </Link>
              ) : (
                attribution.author
              ))}
            {attribution.author && attribution.license && " / "}
            {attribution.license &&
              (licenseUrl ? (
                <Link href={licenseUrl} target="_blank" rel="noopener noreferrer" sx={linkSx}>
                  {attribution.license}
                </Link>
              ) : (
                attribution.license
              ))}
          </Typography>
        )}
      </Box>
      {website && (
        <Link
          href={website}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ display: "flex", alignItems: "center", color: "text.secondary" }}
          aria-label={`${activeBrand.name} website`}
        >
          <LaunchIcon sx={{ fontSize: 18 }} />
        </Link>
      )}
    </Box>
  );
}
