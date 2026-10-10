"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { getTransitDataStatus, type TransitDataEvidence } from "@/lib/transit-data-status";

/** Only show information that changes how a traveler should read the times. */
export function TransitDataStatus({
  now,
  onBanner = false,
  ...evidence
}: TransitDataEvidence & { now: number; onBanner?: boolean }) {
  const t = useTranslations("transit");
  const status = getTransitDataStatus(evidence, now);
  // Refresh failures are explained once by the board/journey notice. Unknown
  // upstream age is not evidence of stale data or a reason to claim live times.
  if (status.failed) return null;
  const message =
    status.freshness === "stale" ? "stale" : status.timing === "scheduled" ? "scheduled" : null;
  if (!message) return null;
  return (
    <Typography
      component="span"
      variant="caption"
      sx={{
        display: "block",
        mt: 0.25,
        color: onBanner ? "inherit" : "text.secondary",
        overflowWrap: "anywhere",
      }}
    >
      {t(`dataStatus.${message}`)}
    </Typography>
  );
}

/** Query-wide uncertainty and retry stay outside clickable departure rows. */
export function TransitQueryNotice({
  failed = false,
  partial = false,
  onRetry,
  retrying = false,
  onMap = false,
}: {
  failed?: boolean;
  partial?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
  onMap?: boolean;
}) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  if (!failed && !partial) return null;
  return (
    <Box
      role="status"
      sx={{
        px: 1.5,
        py: 1,
        ...(onMap
          ? {
              bgcolor: "background.paper",
              color: "text.primary",
              borderRadius: 2,
              boxShadow: 2,
              pointerEvents: "auto",
            }
          : {}),
      }}
    >
      <Typography variant="body2">
        {[failed && t("dataStatus.refreshFailed"), partial && t("dataStatus.partial")]
          .filter(Boolean)
          .join(" ")}
      </Typography>
      {onRetry && (
        <Button size="small" onClick={onRetry} disabled={retrying}>
          {tc("retry")}
        </Button>
      )}
    </Box>
  );
}
