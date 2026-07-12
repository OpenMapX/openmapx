"use client";

import CloseIcon from "@mui/icons-material/Close";
import ThumbDownOffAltIcon from "@mui/icons-material/ThumbDownOffAlt";
import ThumbUpOffAltIcon from "@mui/icons-material/ThumbUpOffAlt";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useNavigationStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useNavIncidents } from "@/lib/navigation/useNavIncidents";
import { selectCrowdApproach } from "./approach";
import { useVote } from "./useCrowdReports";

/**
 * One-tap confirm/negate prompt shown while navigating when the driver nears an
 * active crowd-sourced report ahead on the route. Reuses the existing nav
 * incident projection (`useNavIncidents`) — a crowd report is just an
 * Observation flowing through the same road-conditions pipeline — rather than a
 * parallel proximity detector.
 *
 * Browser-verify: rendering/interaction and the exact crowd-origin id marker
 * depend on the live contributions → road-conditions pipeline.
 */
export function CrowdApproachPrompt() {
  const t = useTranslations("crowdReports");
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const alongMeters = useNavigationStore((s) => s.progress?.alongMeters ?? 0);
  const speedMps = useNavigationStore((s) => s.progress?.speedMps ?? 0);
  const { incidents } = useNavIncidents();
  const vote = useVote();
  // Track every dismissed/voted id in a Set so a report that becomes "nearest"
  // again after another is passed stays suppressed (not just the last one).
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const nearest = useMemo(
    () => selectCrowdApproach(incidents, alongMeters, speedMps, [...dismissed]),
    [incidents, alongMeters, speedMps, dismissed],
  );

  if (!navigating || !nearest) return null;

  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id));

  const castVote = (action: "confirm" | "negate") => {
    vote.mutate({ reportId: nearest.id, subject: nearest.id, action });
    dismiss(nearest.id);
  };

  return (
    <Paper
      elevation={4}
      sx={{
        position: "absolute",
        top: "calc(12px + var(--omx-safe-top))",
        left: "50%",
        transform: "translateX(-50%)",
        px: 2,
        py: 1,
        borderRadius: 3,
        zIndex: 20,
        maxWidth: 360,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {nearest.headline || t("approachStillThere")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("approachPrompt")}
          </Typography>
        </Box>
        <IconButton
          size="small"
          onClick={() => castVote("confirm")}
          aria-label={t("confirm")}
          disabled={vote.isPending}
        >
          <ThumbUpOffAltIcon fontSize="small" color="success" />
        </IconButton>
        <IconButton
          size="small"
          onClick={() => castVote("negate")}
          aria-label={t("negate")}
          disabled={vote.isPending}
        >
          <ThumbDownOffAltIcon fontSize="small" color="error" />
        </IconButton>
        <IconButton size="small" onClick={() => dismiss(nearest.id)} aria-label={t("dismiss")}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
    </Paper>
  );
}
