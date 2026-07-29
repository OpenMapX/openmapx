"use client";

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { ReactNode } from "react";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { JobStatusChip } from "@/components/admin/shared/JobStatusChip";
import {
  type TransitStateSummary,
  useRestartMotis,
  useSyncTransit,
  useTransitJobDetail,
} from "@/lib/admin/transitHooks";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function durationSecs(startedAtIso: string): number {
  const started = new Date(startedAtIso).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.round((Date.now() - started) / 1000));
}

function SummaryMetric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ color: "text.secondary" }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

function RunningJobDetail({ jobId }: { jobId: string }) {
  const { data, isLoading } = useTransitJobDetail(jobId);

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 1.5,
        }}
      >
        <CircularProgress size={20} />
      </Box>
    );
  }

  const stages = data?.stages ?? [];
  const latest = stages[stages.length - 1];

  return (
    <Stack spacing={1.25}>
      <LinearProgress />
      <Stack
        direction="row"
        spacing={2}
        useFlexGap
        sx={{
          flexWrap: "wrap",
        }}
      >
        <Chip
          label={`Job ${jobId.slice(0, 8)}`}
          size="small"
          variant="outlined"
          sx={{ fontFamily: "monospace" }}
        />
        <Chip label={`${stages.length} stage(s) recorded`} size="small" variant="outlined" />
        {latest && (
          <JobStatusChip
            status={latest.status}
            label={`stage: ${latest.stage} (${latest.status})`}
            variant="filled"
          />
        )}
      </Stack>
    </Stack>
  );
}

export function CurrentJobCard({ state }: { state: TransitStateSummary }) {
  const showToast = useAdminToast();
  const syncMutation = useSyncTransit();
  const restartMutation = useRestartMotis();

  const inflight = state.currentJob;

  const onSync = () => {
    syncMutation.mutate(
      {},
      {
        onSuccess: (result) => {
          if (result?.jobId) showToast(`Sync queued (${result.jobId.slice(0, 8)}…)`, "success");
          else showToast("Sync queued", "success");
        },
        onError: (err) =>
          showToast(err instanceof Error ? err.message : "Failed to queue sync", "error"),
      },
    );
  };

  const onRestart = () => {
    restartMutation.mutate(undefined, {
      onSuccess: () => showToast("MOTIS restart triggered", "success"),
      onError: (err) =>
        showToast(err instanceof Error ? err.message : "Failed to restart MOTIS", "error"),
    });
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 1.5,
        }}
      >
        {inflight ? (
          <RefreshIcon color="primary" fontSize="small" />
        ) : (
          <PlayArrowIcon color="action" fontSize="small" />
        )}
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          {inflight ? "Sync in progress" : "Pipeline idle"}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {!inflight && (
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<RestartAltIcon fontSize="small" />}
              onClick={onRestart}
              disabled={restartMutation.isPending}
            >
              Restart MOTIS
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<PlayArrowIcon fontSize="small" />}
              onClick={onSync}
              disabled={syncMutation.isPending}
            >
              Run sync now
            </Button>
          </Stack>
        )}
      </Stack>
      {inflight ? (
        <Stack spacing={1}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            Started {formatTime(inflight.startedAt)} · {durationSecs(inflight.startedAt)}s elapsed
          </Typography>
          <RunningJobDetail jobId={inflight.jobId} />
        </Stack>
      ) : (
        <Stack
          direction="row"
          spacing={3}
          useFlexGap
          sx={{
            flexWrap: "wrap",
          }}
        >
          <SummaryMetric label="Last sync">
            <Typography variant="body2">{formatTime(state.lastSyncAt)}</Typography>
          </SummaryMetric>
          <SummaryMetric label="Last status">
            <JobStatusChip status={state.lastSyncStatus} />
          </SummaryMetric>
          <SummaryMetric label="Total feeds tracked">
            <Typography variant="body2">{state.feedCount}</Typography>
          </SummaryMetric>
        </Stack>
      )}
      {state.lastSyncStatus === "failed" && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          Last sync run failed. Inspect the job detail below for the failing stage.
        </Alert>
      )}
    </Paper>
  );
}
