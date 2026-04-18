"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { Review, ReviewAggregate as ReviewAggregateType } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { StarDisplay } from "./StarDisplay";

interface Props {
  aggregate: ReviewAggregateType | undefined;
  reviews: Review[] | undefined;
  isLoading: boolean;
}

const STAR_ROWS = [5, 4, 3, 2, 1] as const;

/** Compute 5-bucket distribution from the fetched review list (more accurate than what the
 * aggregate endpoint alone gives us — it only returns a single quality score). */
function computeDistribution(reviews: Review[] | undefined): Record<number, number> {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  if (!reviews) return counts;
  for (const r of reviews) {
    if (r.stars === undefined) continue;
    const bucket = Math.max(1, Math.min(5, Math.round(r.stars)));
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

export function ReviewAggregate({ aggregate, reviews, isLoading }: Props) {
  const t = useTranslations("place");

  if (isLoading) {
    return (
      <Box sx={{ display: "flex", gap: 3, mb: 2 }}>
        <Skeleton variant="rectangular" height={100} sx={{ flex: 1, borderRadius: 1 }} />
        <Skeleton variant="rectangular" width={92} height={100} sx={{ borderRadius: 1 }} />
      </Box>
    );
  }

  const count = aggregate?.count ?? 0;
  if (count === 0) {
    return null;
  }

  const distribution = computeDistribution(reviews);
  const rated = reviews?.filter((r) => r.stars !== undefined) ?? [];
  const fallbackStars = rated.length
    ? rated.reduce((sum, r) => sum + (r.stars ?? 0), 0) / rated.length
    : 0;
  // Prefer Mangrove's weighted `stars` when available; fall back to a simple
  // average over the fetched reviews (Mangrove returns null `quality` for
  // tiny aggregates).
  const stars = aggregate && aggregate.stars > 0 ? aggregate.stars : fallbackStars;
  const maxBucket = Math.max(1, ...Object.values(distribution));

  return (
    <Box sx={{ display: "flex", gap: 3, mb: 2 }}>
      <Box sx={{ flex: 1 }}>
        {STAR_ROWS.map((n) => {
          const bucket = distribution[n] ?? 0;
          const pct = (bucket / maxBucket) * 100;
          return (
            <Box key={n} sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
              <Typography variant="caption" sx={{ width: 8, flexShrink: 0 }}>
                {n}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={pct}
                sx={{
                  flex: 1,
                  height: 8,
                  borderRadius: 4,
                  bgcolor: "action.hover",
                  "& .MuiLinearProgress-bar": { bgcolor: "#FBBC04" },
                }}
              />
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ width: 24, textAlign: "right" }}
              >
                {bucket}
              </Typography>
            </Box>
          );
        })}
      </Box>
      <Box sx={{ textAlign: "center", flexShrink: 0 }}>
        <Typography variant="h3" fontWeight={300} lineHeight={1}>
          {stars.toFixed(1)}
        </Typography>
        <Box sx={{ my: 0.5 }}>
          <StarDisplay value={stars} size={20} />
        </Box>
        <Typography variant="caption" color="text.secondary">
          {t("reviewsCount", { count })}
        </Typography>
      </Box>
    </Box>
  );
}
