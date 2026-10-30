"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CopyIcon from "@mui/icons-material/ContentCopy";
import DiagnosticsIcon from "@mui/icons-material/MonitorHeart";
import RefreshIcon from "@mui/icons-material/Refresh";
import UpdateIcon from "@mui/icons-material/SystemUpdateAlt";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { activityJobQueryOptions, useActivityClient } from "../activity/activityQueries";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { ErrorState } from "../shared/ErrorState";

const CONFIRMATION = "UPDATE OPENMAPX";
const HOST_UPDATE_COMMANDS = [
  "pnpm openmapx compose release",
  "pnpm openmapx services update app-api app-web data-manager ops-agent transitous-runner",
].join("\n");

interface ImageStatus {
  id: string;
  name: string;
  image: string | null;
  containerState: string;
  runningImageId: string | null;
  localImageId: string | null;
  updateAvailable: boolean;
  status: "up-to-date" | "update-available" | "not-running" | "unknown";
  error?: string;
}

interface ReleaseStatus {
  configuredSelector?: string;
  currentReleaseId?: string;
  availableReleaseId?: string;
  currentVersion?: string;
  availableVersion?: string;
  availableDigest?: string;
}

interface SystemStatus {
  release?: ReleaseStatus;
  deployment: {
    dockerAvailable: boolean;
    composeRendered: boolean;
    hostControlConfigured: boolean;
    maintenanceReady: boolean;
  };
  images: ImageStatus[];
}

interface TrackedJob {
  path: string;
  id: string;
  label: string;
}

export function buildSystemJobRequestInit(body?: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    credentials: "include",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  };
}

function digest(value: string | null): string {
  if (!value) return "—";
  return value.replace(/^sha256:/, "").slice(0, 12);
}

function imageStatusChip(image: ImageStatus) {
  if (image.status === "update-available") return <Chip color="warning" label="Update available" />;
  if (image.status === "up-to-date") {
    return <Chip color="success" variant="outlined" label="Up to date" />;
  }
  if (image.status === "not-running") return <Chip label="Not running" />;
  return <Chip color="warning" variant="outlined" label="Unknown" />;
}

export function SystemMaintenance() {
  const { apiUrl, client } = useActivityClient();
  const queryClient = useQueryClient();
  const showToast = useAdminToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [candidateToApply, setCandidateToApply] = useState<{
    releaseId: string;
    expectedDigest: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [createBackup, setCreateBackup] = useState(true);
  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);
  const [blockedCandidate, setBlockedCandidate] = useState<string | null>(null);

  const statusQuery = useQuery<SystemStatus>({
    queryKey: ["admin", "system"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/admin/system`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load system maintenance status");
      return response.json();
    },
    refetchInterval: trackedJob ? 5_000 : false,
  });

  const jobQuery = useQuery({
    ...activityJobQueryOptions(client, apiUrl, trackedJob?.id, "application"),
    refetchInterval: trackedJob ? 3_000 : false,
    retry: true,
  });

  useEffect(() => {
    const job = jobQuery.data;
    if (!trackedJob || !job || !["success", "failed", "canceled"].includes(job.status)) return;
    if (
      job.result &&
      typeof job.result === "object" &&
      !Array.isArray(job.result) &&
      job.result.errorCode === "host_update_required"
    ) {
      setBlockedCandidate(candidateToApply?.expectedDigest ?? null);
    }
    if (job.status === "success") {
      if (trackedJob.path === "updates/check") setBlockedCandidate(null);
      showToast(`${trackedJob.label} completed`);
    } else showToast(job.error || `${trackedJob.label} ${job.status}`, "error");
    void queryClient.invalidateQueries({ queryKey: ["admin", "system"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    setTrackedJob(null);
  }, [candidateToApply, jobQuery.data, queryClient, showToast, trackedJob]);

  const queueJob = useMutation({
    mutationFn: async ({
      path,
      body,
      label,
    }: {
      path: string;
      body?: Record<string, unknown>;
      label: string;
    }) => {
      const response = await fetch(
        `${apiUrl}/api/admin/system/${path}`,
        buildSystemJobRequestInit(body),
      );
      const result = (await response.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !result.jobId)
        throw new Error(result.error ?? `Failed to queue ${label}`);
      return { id: result.jobId, label, path };
    },
    onSuccess: (job) => {
      setTrackedJob(job);
      showToast(`${job.label} queued`);
    },
    onError: (error) =>
      showToast(error instanceof Error ? error.message : "Request failed", "error"),
  });

  const status = statusQuery.data;
  const active = Boolean(trackedJob || queueJob.isPending);
  const progress = jobQuery.data?.progress ?? 0;
  const updateCount = status?.images.filter((image) => image.updateAvailable).length ?? 0;
  const checkedCandidate =
    status?.release?.availableReleaseId && status.release.availableDigest
      ? {
          releaseId: status.release.availableReleaseId,
          expectedDigest: status.release.availableDigest,
        }
      : null;
  // The agent status includes the backup helper pin check, even when its image is current.
  // An outdated agent is replaced by the update itself; an unverifiable agent, or
  // a replacement that failed for this release, still needs the host.
  const agent = status?.images.find((image) => image.id === "ops-agent");
  const agentReplacementFailed = Boolean(
    checkedCandidate && blockedCandidate === checkedCandidate.expectedDigest,
  );
  const hostUpdateRequired = Boolean(
    checkedCandidate &&
      (agentReplacementFailed ||
        (agent?.status !== "up-to-date" && agent?.status !== "update-available")),
  );
  const replacesAgent = Boolean(
    checkedCandidate && !hostUpdateRequired && agent?.status === "update-available",
  );
  const canUpdate = Boolean(
    checkedCandidate &&
      !hostUpdateRequired &&
      (updateCount > 0 ||
        status?.release?.availableReleaseId !== status?.release?.currentReleaseId),
  );

  if (statusQuery.isError) {
    return (
      <ErrorState
        message="System maintenance status could not be loaded."
        onRetry={() => statusQuery.refetch()}
      />
    );
  }

  return (
    <Stack sx={{ gap: 2 }}>
      <AdminPageHeader
        title="System maintenance"
        subtitle="Update the OpenMapX application and run host-level diagnostics"
        actions={
          <Button component={Link} href="/admin/activity" variant="outlined">
            View activity
          </Button>
        }
      />

      {status && !status.deployment.maintenanceReady && (
        <Alert severity="warning">
          Host maintenance is unavailable. Docker access, a rendered Compose file, and the host
          checkout mount are required. Read-only admin features remain available.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, overflowWrap: "anywhere" }}>
        <Typography variant="subtitle1">Release selection</Typography>
        <Typography variant="body2">
          Configured channel: {status?.release?.configuredSelector ?? "unknown"}
        </Typography>
        <Typography variant="body2">
          Current release: {status?.release?.currentReleaseId ?? "unknown"}
        </Typography>
        <Typography variant="body2">
          Checked release: {status?.release?.availableReleaseId ?? "not checked"}
        </Typography>
        {status?.release?.availableDigest && (
          <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
            Manifest: {status.release.availableDigest}
          </Typography>
        )}
        <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
          Check reads the configured release manifest without downloading images or restarting
          services. Update downloads that exact checked release before replacing any container.
          Change channels in the host configuration.
        </Typography>
      </Paper>

      {hostUpdateRequired && (
        <Alert severity="warning" sx={{ minWidth: 0 }}>
          <AlertTitle>Host update required</AlertTitle>
          <Typography variant="body2">
            {agentReplacementFailed
              ? "The operations agent could not be updated from the admin panel. The previous agent keeps running."
              : "The operations agent or its backup helper could not be verified for this release. Updating from the admin panel is blocked."}{" "}
            Run these commands from an updated OpenMapX checkout on the host.
          </Typography>
          <Box
            component="pre"
            sx={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: "0.8125rem",
              my: 1.5,
            }}
          >
            {HOST_UPDATE_COMMANDS}
          </Box>
          <Button
            size="small"
            startIcon={<CopyIcon />}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(HOST_UPDATE_COMMANDS);
                showToast("Host update commands copied");
              } catch {
                showToast("Could not copy commands. Select and copy the commands above.", "error");
              }
            }}
          >
            Copy commands
          </Button>
        </Alert>
      )}

      {replacesAgent && (
        <Alert severity="info">
          This release also updates the operations agent. The update replaces it first and checks
          that the new agent starts. If it does not, the previous agent is restored and the update
          stops before any other service changes.
        </Alert>
      )}

      {trackedJob && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1 }}>
              {trackedJob.label}
            </Typography>
            <Chip label={jobQuery.data?.status ?? "queued"} color="primary" variant="outlined" />
          </Stack>
          <LinearProgress
            variant={progress > 0 ? "determinate" : "indeterminate"}
            value={progress}
          />
        </Paper>
      )}

      <AdminTableSurface
        title="OpenMapX application"
        description="Checking compares running images with the release. Only Update downloads images."
        toolbar={
          <Stack
            direction={{ xs: "column", sm: "row" }}
            sx={{ gap: 1, alignItems: { sm: "center" } }}
          >
            {updateCount > 0 && (
              <Chip
                color="warning"
                label={`${updateCount} ${updateCount === 1 ? "update" : "updates"} available`}
              />
            )}
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              disabled={active || !status?.deployment.maintenanceReady}
              onClick={() => queueJob.mutate({ path: "updates/check", label: "Update check" })}
            >
              Check for updates
            </Button>
            <Button
              variant="contained"
              startIcon={<UpdateIcon />}
              disabled={active || !status?.deployment.maintenanceReady || !canUpdate}
              title={
                hostUpdateRequired
                  ? "This release requires an update on the host"
                  : !canUpdate
                    ? "Check for a release with changes before updating"
                    : undefined
              }
              onClick={() => {
                setCandidateToApply(checkedCandidate);
                setDialogOpen(true);
              }}
            >
              Update OpenMapX
            </Button>
          </Stack>
        }
      >
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Component</TableCell>
                <TableCell>Image</TableCell>
                <TableCell>Running</TableCell>
                <TableCell>Downloaded</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(status?.images ?? []).map((image) => (
                <TableRow key={image.id} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {image.name}
                    </Typography>
                    <Typography variant="caption" sx={{ color: "text.secondary" }}>
                      {image.id} · {image.containerState}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>{image.image ?? "—"}</TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {digest(image.runningImageId)}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {digest(image.localImageId)}
                  </TableCell>
                  <TableCell>{imageStatusChip(image)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </AdminTableSurface>

      <Paper component="section" variant="outlined" sx={{ p: 2 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          sx={{ gap: 2, alignItems: { sm: "center" } }}
        >
          <DiagnosticsIcon color="primary" />
          <Box sx={{ flexGrow: 1 }}>
            <Typography component="h2" variant="subtitle1">
              Deep diagnostics
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Runs the CLI-equivalent container health checks and in-network HTTP probes. Detailed
              output is retained in Activity.
            </Typography>
          </Box>
          <Button
            variant="outlined"
            startIcon={<DiagnosticsIcon />}
            disabled={active || !status?.deployment.maintenanceReady}
            onClick={() => queueJob.mutate({ path: "diagnostics", label: "Deep diagnostics" })}
          >
            Run diagnostics
          </Button>
        </Stack>
      </Paper>

      <Paper component="section" variant="outlined" sx={{ p: 2 }}>
        <Typography component="h2" variant="subtitle1" sx={{ mb: 1.5 }}>
          Host-control readiness
        </Typography>
        <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
          {[
            ["Docker", status?.deployment.dockerAvailable],
            ["Compose rendered", status?.deployment.composeRendered],
            ["Host checkout mounted", status?.deployment.hostControlConfigured],
          ].map(([label, ok]) => (
            <Chip
              key={String(label)}
              icon={ok ? <CheckCircleIcon /> : undefined}
              color={ok ? "success" : "warning"}
              variant="outlined"
              label={label}
            />
          ))}
        </Stack>
      </Paper>

      <Dialog
        open={dialogOpen}
        onClose={active ? undefined : () => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Update OpenMapX</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 0.5 }}>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              Apply checked release {candidateToApply?.releaseId}. Manifest:{" "}
              {candidateToApply?.expectedDigest}
            </Typography>
            <Alert severity="info">
              Images are downloaded before containers are replaced. Services update in dependency
              order, with the operations agent last. API or proxy updates may briefly interrupt this
              page; reconnect to follow the original job.
            </Alert>
            <FormControlLabel
              control={
                <Checkbox
                  checked={createBackup}
                  onChange={(event) => setCreateBackup(event.target.checked)}
                />
              }
              label="Create a pre-update backup (recommended)"
            />
            {!createBackup && (
              <Alert severity="warning">
                Database migrations are forward-only. Updating without a backup reduces recovery
                options.
              </Alert>
            )}
            <TextField
              autoFocus
              label={`Type ${CONFIRMATION} to continue`}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={queueJob.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={<UpdateIcon />}
            disabled={
              confirmation !== CONFIRMATION ||
              queueJob.isPending ||
              !candidateToApply ||
              hostUpdateRequired
            }
            onClick={() => {
              queueJob.mutate({
                path: "updates/apply",
                body: { confirmation, createBackup, ...candidateToApply },
                label: "OpenMapX update",
              });
              setDialogOpen(false);
              setConfirmation("");
            }}
          >
            Update application
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
