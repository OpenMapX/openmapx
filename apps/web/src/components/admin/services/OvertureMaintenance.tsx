"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MergeIcon from "@mui/icons-material/Merge";
import RefreshIcon from "@mui/icons-material/Refresh";
import SyncIcon from "@mui/icons-material/Sync";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { OvertureRecoveryStatus, OvertureStatus } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { SERVICE_READ_TIMEOUT_MS } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import {
  type AdminOperationFormValues,
  previewAdminOperation,
  runAdminOperation,
} from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

type Operation =
  | "overture-sync"
  | "overture-conflate"
  | "overture-restart"
  | "overture-pull"
  | "overture-ingest"
  | "overture-extract";
const operationLabels: Record<Operation, string> = {
  "overture-sync": "Full sync",
  "overture-conflate": "Resume links",
  "overture-restart": "Restart links from scratch",
  "overture-pull": "Download release partition",
  "overture-ingest": "Ingest downloaded partition",
  "overture-extract": "Extract OSM features",
};
function operationRequest(name: Operation, region: string) {
  return {
    id: name === "overture-restart" ? "overture-conflate" : name,
    input: {
      region,
      ...(["overture-restart", "overture-conflate"].includes(name)
        ? { restart: name === "overture-restart" }
        : {}),
    } as AdminOperationFormValues,
  };
}

export function overtureProgress(
  status:
    | Partial<
        Pick<
          OvertureStatus,
          | "status"
          | "phase"
          | "extractedCount"
          | "processedCount"
          | "componentCount"
          | "assignmentCursor"
          | "emittedCount"
          | "placeCount"
        >
      >
    | null
    | undefined,
): {
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
  status: Pick<OvertureStatus, "status" | "stalled"> | null | undefined,
  region: string,
  operationPending: boolean,
): boolean {
  return (
    region.trim().length > 0 &&
    !operationPending &&
    (status?.status !== "running" || status.stalled === true)
  );
}

export function overtureStatusQueryKey(apiUrl: string) {
  return ["admin", "overture", apiUrl, "status"] as const;
}

export function OvertureMaintenance({ apiUrl }: { apiUrl: string }) {
  return <OvertureMaintenanceView key={apiUrl} apiUrl={apiUrl} />;
}
function OvertureMaintenanceView({ apiUrl }: { apiUrl: string }) {
  const showToast = useAdminToast();
  const register = useServiceJobRegistration();
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [region, setRegion] = useState("");
  const [prepared, setPrepared] = useState<{
    name: Operation;
    region: string;
    input: AdminOperationFormValues;
    preview: Awaited<ReturnType<typeof previewAdminOperation>>;
  } | null>(null);
  const confirmOperation = prepared?.name ?? null;

  const statusQuery = useQuery<OvertureStatus | null>({
    queryKey: overtureStatusQueryKey(apiUrl),
    queryFn: async ({ signal }) => {
      const response = await sdk.getApiDataManagerOvertureStatus({
        client,
        signal,
        timeoutMs: SERVICE_READ_TIMEOUT_MS,
      });
      if (response.status === 404) return null;
      return sdk.unwrapAdminResponse(response);
    },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 10_000 : 60_000),
  });

  const regionValid =
    /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/.test(region.trim()) && region.trim().length <= 512;
  const recoveryQuery = useQuery<OvertureRecoveryStatus>({
    queryKey: [...overtureStatusQueryKey(apiUrl), "recovery", region.trim()],
    enabled: regionValid,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.getApiDataManagerOvertureRecovery(
          { region: region.trim() },
          { client, signal, timeoutMs: SERVICE_READ_TIMEOUT_MS },
        ),
      ),
    refetchInterval: (query) => (query.state.data?.busy ? 10000 : 30000),
  });

  const owner = useAdminMutationOwner(client, JSON.stringify([region, confirmOperation]));
  const prepare = useMutation({
    retry: false,
    mutationFn: async (name: Operation) => {
      const scope = owner,
        selectedRegion = region.trim(),
        request = operationRequest(name, selectedRegion);
      try {
        const preview = await previewAdminOperation(client, request.id, request.input);
        if (scope.active)
          setPrepared({ name, region: selectedRegion, input: request.input, preview });
      } catch (error) {
        if (scope.active)
          showToast(error instanceof Error ? error.message : "Preview failed", "error");
      }
    },
  });
  const operation = useMutation({
    retry: false,
    mutationFn: async (operationName: Operation) => {
      const execution = owner;
      const effect = {
        kind: "operations",
        refreshKeys: [overtureStatusQueryKey(apiUrl)],
      } as const;
      try {
        if (!prepared || prepared.name !== operationName || prepared.region !== region.trim())
          throw Error("The operation preview changed. Review it again.");
        const request = operationRequest(operationName, prepared.region);
        const jobId = await runAdminOperation(client, request.id, prepared.input);
        register({ client, apiUrl, jobId, effect });
        if (execution.active) {
          showToast(`Queued ${operationName} (${jobId})`);
          setPrepared(null);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Operation failed", "error");
        throw error;
      }
    },
  });

  const status = statusQuery.data;
  const progress = overtureProgress(status);
  const recovery = recoveryQuery.data;
  const busy = recovery?.busy === true || (status?.status === "running" && !status.stalled);
  const pending = operation.isPending || prepare.isPending;
  const canRun = (name: Operation) =>
    regionValid &&
    !pending &&
    !busy &&
    Boolean(recovery) &&
    (name === "overture-sync" || recovery?.actions?.[name]?.allowed === true);
  const leaseReason = recovery?.busy
    ? "Another Overture operation holds the workspace lease."
    : status?.status === "running" && !status.stalled
      ? "The Overture link worker is still running."
      : null;

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
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => {
            void statusQuery.refetch();
            if (regionValid) void recoveryQuery.refetch();
          }}
        >
          Refresh
        </Button>
        <Button component={Link} href="/admin/activity" variant="text">
          View jobs
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {sdk.adminErrorMessage(
            statusQuery.error,
            statusQuery.error instanceof Error ? statusQuery.error.message : "Status unavailable",
          )}
        </Alert>
      )}
      {status === null && (
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
          disabled={!canRun("overture-sync")}
          onClick={() => prepare.mutate("overture-sync")}
        >
          Full sync
        </Button>
        <Button
          variant="outlined"
          startIcon={<MergeIcon />}
          disabled={
            !canRun("overture-conflate") || !canResumeOvertureLinks(status, region, pending)
          }
          onClick={() => prepare.mutate("overture-conflate")}
        >
          Resume links
        </Button>
      </Stack>

      {leaseReason && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {leaseReason}
        </Alert>
      )}
      {regionValid && recoveryQuery.isError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          Prerequisite inspection is unavailable. Restore connectivity and refresh before queuing
          work.
        </Alert>
      )}
      <Button
        sx={{ mt: 1 }}
        color="warning"
        variant="outlined"
        disabled={!canRun("overture-restart")}
        onClick={() => prepare.mutate("overture-restart")}
      >
        Restart links from scratch
      </Button>
      {regionValid && !busy && recovery?.actions?.["overture-conflate"]?.reason && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {recovery.actions["overture-conflate"].reason}
        </Typography>
      )}
      <Accordion sx={{ mt: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography>Advanced recovery</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" sx={{ mb: 1 }}>
            Run an individual recovery step. Full sync remains the usual workflow. Inputs are
            checked again under the existing workspace lease.
          </Typography>
          {recovery && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              Completed local partition: {recovery.downloadedRelease ?? "none"} · OSM PBF:{" "}
              {recovery.osmAvailable ? "available" : "missing"} · Installed release:{" "}
              {recovery.installedRelease ?? "none"}
            </Typography>
          )}
          <Stack spacing={1}>
            {(["overture-pull", "overture-ingest", "overture-extract"] as const).map((name) => (
              <Box key={name}>
                <Button
                  variant="outlined"
                  disabled={!canRun(name)}
                  onClick={() => prepare.mutate(name)}
                >
                  {operationLabels[name]}
                </Button>
                {!busy && recovery?.actions?.[name]?.reason && (
                  <Typography variant="caption" sx={{ display: "block" }}>
                    {recovery.actions[name].reason}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </AccordionDetails>
      </Accordion>

      <ConfirmDialog
        open={prepared !== null && prepared.region === region.trim()}
        title={
          prepared?.preview.confirmation?.title ??
          (confirmOperation ? operationLabels[confirmOperation] : "Review Overture operation")
        }
        message={[prepared?.preview.confirmation?.message, ...(prepared?.preview.preview ?? [])]
          .filter(Boolean)
          .join(" · ")}
        confirmLabel={
          confirmOperation === "overture-restart"
            ? "Restart links"
            : confirmOperation === "overture-conflate"
              ? "Resume"
              : "Run operation"
        }
        confirmColor={prepared?.preview.risk === "destructive" ? "warning" : "primary"}
        loading={operation.isPending}
        onCancel={() => setPrepared(null)}
        onConfirm={() => {
          if (confirmOperation) operation.mutate(confirmOperation);
        }}
      />
    </Paper>
  );
}
