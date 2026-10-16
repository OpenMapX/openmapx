"use client";

import LaunchIcon from "@mui/icons-material/Launch";
import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { safeHref, useBrandDetail, useCategorySearchStore } from "@openmapx/core";
import { contributorsForField, snapshotContributors } from "@openmapx/mobility-core/contributors";
import { BrandLogo } from "@/components/search/BrandLogo";
import { AttributionStrip } from "@/components/ui/AttributionStrip";

/**
 * Identity strip above the results when the Explore list is showing one chain.
 *
 * The name and description come from the store so the card paints immediately
 * on selection; the detail query only adds the website, which arrives late
 * without shifting the layout. Per-logo Commons attribution (author, licence)
 * resolves later still and just as silently — see `useBrandLogoAttribution`.
 * Every logo carries its own exact-file credit through BrandLogo.
 */
export function BrandHeaderCard() {
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const { data: detail } = useBrandDetail(activeBrand?.qid ?? null);

  if (!activeBrand) return null;

  const description = activeBrand.description ?? detail?.description;
  const website = safeHref(detail?.website);
  const fieldCredits = snapshotContributors(
    contributorsForField(activeBrand, "name"),
    description
      ? contributorsForField(
          activeBrand.description !== undefined ? activeBrand : (detail ?? {}),
          "description",
        )
      : [],
    website ? contributorsForField(detail ?? {}, "website") : [],
  );

  return (
    <BrandLogo
      brand={activeBrand}
      size={36}
      render={({ mark, credits }) => (
        <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: "divider" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Box sx={{ display: "flex", flexShrink: 0 }}>{mark}</Box>
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
          {fieldCredits.length > 0 && (
            <AttributionStrip attributions={fieldCredits} variant="plain" />
          )}
          {credits && (
            <Box sx={{ mt: 0.5, color: "text.secondary", fontSize: "0.65rem" }}>{credits}</Box>
          )}
        </Box>
      )}
    />
  );
}
