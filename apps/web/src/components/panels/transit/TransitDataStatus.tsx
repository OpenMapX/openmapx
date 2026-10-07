"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { getTransitDataStatus, type TransitDataEvidence } from "@/lib/transit-data-status";

/** A readable explanation, rather than a coloured dot or a provider-enabled badge. */
export function TransitDataStatus({
  now,
  onBanner = false,
  ...evidence
}: TransitDataEvidence & { now: number; onBanner?: boolean }) {
  const t = useTranslations("transit");
  const status = getTransitDataStatus(evidence, now);
  const parts = [t(`dataStatus.${status.timing === "unknown" ? "timingUnknown" : status.timing}`)];
  if (status.timing !== "scheduled") {
    parts.push(t(`dataStatus.${status.freshness}`));
    if (status.ageSeconds !== null) parts.push(t("dataStatus.age", { seconds: status.ageSeconds }));
  }
  if (status.source !== "unknown") parts.push(t(`dataStatus.${status.source}`));
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
      {parts.join(" · ")}
    </Typography>
  );
}

/** Query-wide uncertainty and retry stay outside clickable departure rows. */
export function TransitQueryNotice({
  failed = false,
  partial = false,
  onRetry,
  retrying = false,
}: {
  failed?: boolean;
  partial?: boolean;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations("transit");
  const tc = useTranslations("common");
  if (!failed && !partial) return null;
  return (
    <Box role="status" sx={{ px: 1.5, py: 1 }}>
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
