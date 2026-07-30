"use client";

import MergeIcon from "@mui/icons-material/Merge";
import RefreshIcon from "@mui/icons-material/Refresh";
import SyncIcon from "@mui/icons-material/Sync";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

interface OvertureStatus {
  ok?: boolean;
  error?: string;
  release?: string;
  region?: string;
  placeCount?: number;
  status?: string;
  phase?: string;
  emittedCount?: number | null;
  extractedCount?: number | null;
  processedCount?: number | null;
  componentCount?: number | null;
  assignmentCursor?: number | null;
  linkedCount?: number | null;
  attemptCount?: number;
  lastError?: string | null;
  heartbeatAgeMs?: number;
  stalled?: boolean;
}

type Operation = "overture-sync" | "overture-conflate";

export function overtureProgress(status: OvertureStatus | undefined): {
  value: number | null;
  label: string;
} | null {
  if (status?.status !== "running") return null;
  if (
    status.phase === "score" &&
    status.extractedCount &&
    status.processedCount !== null &&
    status.processedCount !== undefined
  ) {
    return {
      value: Math.min(100, (status.processedCount / status.extractedCount) * 100),
      label: `${status.processedCount.toLocaleString()} of ${status.extractedCount.toLocaleString()} OSM POIs scored`,
    };
  }
  if (
    status.phase === "assign" &&
    status.componentCount &&
    status.assignmentCursor !== null &&
    status.assignmentCursor !== undefined
  ) {
    return {
      value: Math.min(100, (status.assignmentCursor / status.componentCount) * 100),
      label: `${status.assignmentCursor.toLocaleString()} of ${status.componentCount.toLocaleString()} components assigned`,
    };
  }
  const label =
    status.phase === "extract"
      ? `${status.emittedCount?.toLocaleString() ?? "0"} OSM geometries streamed`
      : status.phase === "publish"
        ? "Validating and publishing links"
        : "Preparing Overture conflation";
  return { value: null, label };
}

export function canResumeOvertureLinks(
  status: OvertureStatus | undefined,
  region: string,
  operationPending: boolean,
): boolean {
  return (
    region.trim().length > 0 &&
    !operationPending &&
    (status?.status !== "running" || status.stalled === true)
  );
}

export function OvertureMaintenance({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const queryClient = useQueryClient();
  const [region, setRegion] = useState("");
  const [confirmOperation, setConfirmOperation] = useState<Operation | null>(null);

  const statusQuery = useQuery<OvertureStatus>({
    queryKey: ["admin", "overture", "status"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/data-manager/overture/status`, {
        credentials: "include",
      });
      const body = (await response.json().catch(() => ({}))) as OvertureStatus;
      if (response.status === 404) return body;
      if (!response.ok) throw new Error(body.error ?? "Failed to load Overture status");
      return body;
    },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 10_000 : 60_000),
  });

  const operation = useMutation({
    mutationFn: async (operationName: Operation) => {
      const response = await fetch(`${apiUrl}/api/admin/services/data/action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation: operationName, region: region.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !body.jobId) {
        throw new Error(body.error ?? "Failed to queue Overture operation");
      }
      return body.jobId;
    },
    onSuccess: (jobId, operationName) => {
      showToast(`Queued ${operationName} (${jobId})`);
      setConfirmOperation(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : "Operation failed", "error"),
  });

  const status = statusQuery.data;
  const progress = overtureProgress(status);
  const visiblePhase =
    status?.status === "completed" && status.phase === "complete" ? undefined : status?.phase;

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ gap: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
            <MergeIcon color="primary" />
            <Typography component="h2" variant="h6">
              Overture Places
            </Typography>
            {status?.status && (
              <Chip
                label={`${status.status}${visiblePhase ? ` · ${visiblePhase}` : ""}`}
                color={status.stalled || status.status === "failed" ? "error" : "primary"}
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            Pull and atomically ingest the release-pinned regional Places dataset, then maintain the
            durable OSM↔GERS link index.
          </Typography>
        </Box>
        <Button startIcon={<RefreshIcon />} onClick={() => statusQuery.refetch()}>
          Refresh
        </Button>
        <Button component={Link} href="/admin/activity" variant="text">
          View jobs
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {statusQuery.error instanceof Error ? statusQuery.error.message : "Status unavailable"}
        </Alert>
      )}
      {status && status.ok === false && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          Overture Places has not been ingested yet. Choose the same Geofabrik-style region used for
          OSM data and run a full sync.
        </Alert>
      )}
      {status?.lastError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {status.lastError}
        </Alert>
      )}
      {status?.stalled && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          The worker heartbeat is stale
          {status.heartbeatAgeMs ? ` (${Math.floor(status.heartbeatAgeMs / 60_000)} minutes)` : ""}.
          The expired lease can be reclaimed safely with Resume links.
        </Alert>
      )}

      {status?.ok && (
        <Stack direction="row" sx={{ gap: 3, flexWrap: "wrap", mt: 1.5 }}>
          {[
            ["Release", status.release ?? "—"],
            ["Region", status.region ?? "—"],
            ["Places", status.placeCount?.toLocaleString() ?? "—"],
            ["Linked", status.linkedCount?.toLocaleString() ?? "—"],
            ["Attempts", String(status.attemptCount ?? "—")],
          ].map(([label, value]) => (
            <Box key={label}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {label}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
      {progress && (
        <Box sx={{ mt: 1.5 }}>
          <LinearProgress
            variant={progress.value === null ? "indeterminate" : "determinate"}
            value={progress.value ?? undefined}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {progress.label}
          </Typography>
        </Box>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        sx={{ gap: 1, alignItems: { sm: "center" }, mt: 2 }}
      >
        <TextField
          label="Region"
          placeholder="europe/germany"
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          sx={{ minWidth: 240 }}
        />
        <Button
          variant="contained"
          startIcon={<SyncIcon />}
          disabled={!region.trim() || operation.isPending || status?.status === "running"}
          onClick={() => setConfirmOperation("overture-sync")}
        >
          Full sync
        </Button>
        <Button
          variant="outlined"
          startIcon={<MergeIcon />}
          disabled={!canResumeOvertureLinks(status, region, operation.isPending)}
          onClick={() => setConfirmOperation("overture-conflate")}
        >
          Resume links
        </Button>
      </Stack>

      <ConfirmDialog
        open={confirmOperation !== null}
        title={
          confirmOperation === "overture-sync" ? "Sync Overture Places" : "Resume Overture links"
        }
        message={
          confirmOperation === "overture-sync"
            ? `Download and atomically ingest the current Overture release for "${region}", then begin the durable link rebuild? This is a long-running, network- and disk-intensive job.`
            : `Resume the durable OSM↔GERS link workflow for "${region}" from its saved phase?`
        }
        confirmLabel={confirmOperation === "overture-sync" ? "Start full sync" : "Resume"}
        loading={operation.isPending}
        onCancel={() => setConfirmOperation(null)}
        onConfirm={() => {
          if (confirmOperation) operation.mutate(confirmOperation);
        }}
      />
    </Paper>
  );
}
