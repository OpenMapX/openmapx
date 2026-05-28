"use client";

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { Review } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ReviewCard } from "./ReviewCard";

type SortKey = "newest" | "highest" | "lowest";

interface Props {
  reviews: Review[] | undefined;
  isLoading: boolean;
  currentUserPem?: string | null;
  onEdit?: (review: Review) => void;
  onDelete?: (review: Review) => void;
  onReport?: (review: Review) => void;
}

export function ReviewList({
  reviews,
  isLoading,
  currentUserPem,
  onEdit,
  onDelete,
  onReport,
}: Props) {
  const t = useTranslations("place");
  const [sort, setSort] = useState<SortKey>("newest");

  const sorted = useMemo(() => {
    if (!reviews) return [];
    const list = [...reviews];
    list.sort((a, b) => {
      if (sort === "newest") return a.createdAt < b.createdAt ? 1 : -1;
      const sa = a.stars ?? 0;
      const sb = b.stars ?? 0;
      if (sort === "highest") return sb - sa;
      return sa - sb;
    });
    return list;
  }, [reviews, sort]);

  if (isLoading) {
    return (
      <Box>
        {[0, 1, 2].map((i) => (
          <Box key={i} sx={{ py: 2 }}>
            <Skeleton variant="circular" width={36} height={36} />
            <Skeleton variant="text" sx={{ mt: 1 }} />
            <Skeleton variant="text" width="80%" />
            <Skeleton variant="text" width="40%" />
          </Box>
        ))}
      </Box>
    );
  }

  if (!sorted.length) {
    return (
      <Box sx={{ py: 6, textAlign: "center" }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          {t("noReviewsYet")}
        </Typography>
      </Box>
    );
  }

  return (
    <Box>
      <Tabs
        value={sort}
        onChange={(_, v: SortKey) => setSort(v)}
        variant="standard"
        sx={{
          mb: 0,
          minHeight: 36,
          "& .MuiTab-root": { minHeight: 36, textTransform: "none", fontSize: 13, px: 1.5 },
        }}
      >
        <Tab value="newest" label={t("sortNewest")} />
        <Tab value="highest" label={t("sortHighest")} />
        <Tab value="lowest" label={t("sortLowest")} />
      </Tabs>
      {sorted.map((review) => (
        <ReviewCard
          key={review.id}
          review={review}
          currentUserPem={currentUserPem}
          onEdit={onEdit}
          onDelete={onDelete}
          onReport={onReport}
        />
      ))}
    </Box>
  );
}
