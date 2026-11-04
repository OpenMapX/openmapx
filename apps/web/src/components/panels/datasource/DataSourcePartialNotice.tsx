"use client";

import Box from "@mui/material/Box";
import type { DataSourcePartialReason } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { ResultNotice } from "@/components/ui/ResultNotice";

/**
 * Says a data-source answer is partial. For `area`, a source fetched only part
 * of the view, so a closer view asks it for less and loads the rest. For
 * `unavailable`, a source did not answer at all: zooming in does not change
 * that, so the notice offers to ask again instead.
 */
export function DataSourcePartialNotice({
  reason,
  onZoomIn,
  onRetry,
  retrying = false,
}: {
  reason: DataSourcePartialReason;
  onZoomIn: () => void;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations("dataSources");
  const tm = useTranslations("map");
  const tc = useTranslations("common");
  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      {reason === "unavailable" ? (
        <ResultNotice
          tone="info"
          pending={retrying}
          action={{ label: tc("retry"), kind: "retry", onClick: onRetry }}
        >
          {t("sourceDidNotAnswer")}
        </ResultNotice>
      ) : (
        <ResultNotice tone="info" action={{ label: tm("zoomIn"), kind: "zoom", onClick: onZoomIn }}>
          {t("zoomInToLoadMore")}
        </ResultNotice>
      )}
    </Box>
  );
}
