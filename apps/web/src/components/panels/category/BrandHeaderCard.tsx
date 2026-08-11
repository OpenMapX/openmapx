"use client";

import LaunchIcon from "@mui/icons-material/Launch";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useBrandDetail, useCategorySearchStore } from "@openmapx/core";
import { BrandLogo } from "@/components/search/BrandLogo";

/**
 * Identity strip above the results when the Explore list is showing one chain.
 *
 * The name and description come from the store so the card paints immediately
 * on selection; the detail query only adds the website, which arrives late
 * without shifting the layout.
 */
export function BrandHeaderCard() {
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const { data: detail } = useBrandDetail(activeBrand?.qid ?? null);

  if (!activeBrand) return null;

  const description = activeBrand.description ?? detail?.description;

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
      </Box>
      {detail?.website && (
        <Link
          href={detail.website}
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
