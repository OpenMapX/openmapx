"use client";

import Box from "@mui/material/Box";
import { useTranslations } from "next-intl";
import { ResultNotice } from "@/components/ui/ResultNotice";

/**
 * Says a data-source answer is partial: a source fetched only part of the
 * view, or not yet. A closer view asks it for less, so it can load the rest.
 */
export function DataSourcePartialNotice({ onZoomIn }: { onZoomIn: () => void }) {
  const t = useTranslations("dataSources");
  const tm = useTranslations("map");
  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <ResultNotice tone="info" action={{ label: tm("zoomIn"), kind: "zoom", onClick: onZoomIn }}>
        {t("zoomInToLoadMore")}
      </ResultNotice>
    </Box>
  );
}
