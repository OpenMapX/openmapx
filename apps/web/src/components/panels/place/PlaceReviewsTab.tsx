"use client";

import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import StarIcon from "@mui/icons-material/Star";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { useTranslations } from "next-intl";

interface Props {
  place: Place;
}

const STAR_ROWS = [5, 4, 3, 2, 1] as const;

function StarRow({ rating }: { rating: number }) {
  const rounded = Math.round(rating);
  return (
    <Box sx={{ display: "flex", gap: 0.25 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <StarIcon
          key={n}
          sx={{ fontSize: 20, color: n <= rounded ? "#FBBC04" : "action.disabled" }}
        />
      ))}
    </Box>
  );
}

export function PlaceReviewsTab({ place }: Props) {
  const t = useTranslations("place");
  const links = place.reviewLinks ?? [];

  return (
    <Box sx={{ px: 2, pt: 2, pb: 2 }}>
      {/* Aggregate score — only rendered when rating data is present */}
      {place.rating && (
        <>
          <Box sx={{ display: "flex", gap: 3, mb: 2 }}>
            <Box sx={{ flex: 1 }}>
              {STAR_ROWS.map((n) => (
                <Box key={n} sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
                  <Typography variant="caption" sx={{ width: 8, flexShrink: 0 }}>
                    {n}
                  </Typography>
                  <LinearProgress
                    variant="determinate"
                    value={0}
                    sx={{
                      flex: 1,
                      height: 8,
                      borderRadius: 4,
                      bgcolor: "action.hover",
                      "& .MuiLinearProgress-bar": { bgcolor: "#FBBC04" },
                    }}
                  />
                </Box>
              ))}
            </Box>
            <Box sx={{ textAlign: "center", flexShrink: 0 }}>
              <Typography variant="h3" fontWeight={300} lineHeight={1}>
                {place.rating.toFixed(1)}
              </Typography>
              <StarRow rating={place.rating} />
              <Typography variant="caption" color="text.secondary">
                {t("reviewsCount", { count: place.reviewCount ?? 0 })}
              </Typography>
            </Box>
          </Box>
          <Divider sx={{ mb: 2 }} />
        </>
      )}

      {/* External platform links */}
      {links.length > 0 && (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5, px: 0 }}>
            {t("findReviewsOn")}
          </Typography>
          {links.map(({ platform, url }) => (
            <Box
              key={platform}
              component="a"
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                py: 1.25,
                mx: -2,
                px: 2,
                textDecoration: "none",
                color: "inherit",
                "&:hover": { bgcolor: "action.hover" },
              }}
            >
              <Typography variant="body2" sx={{ flex: 1 }}>
                {platform}
              </Typography>
              <OpenInNewIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
            </Box>
          ))}
          <Divider sx={{ mt: 1, mb: 2 }} />
        </>
      )}

      {/* Open data note */}
      <Typography variant="caption" color="text.secondary" align="center" sx={{ display: "block" }}>
        {t("openDataNote")}
      </Typography>
    </Box>
  );
}
