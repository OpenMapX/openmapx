"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import DiagnosticsIcon from "@mui/icons-material/MonitorHeart";
import RefreshIcon from "@mui/icons-material/Refresh";
import UpdateIcon from "@mui/icons-material/SystemUpdateAlt";
import Alert from "@mui/material/Alert";
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
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { ErrorState } from "../shared/ErrorState";

const CONFIRMATION = "UPDATE OPENMAPX";

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

interface SystemStatus {
  deployment: {
    dockerAvailable: boolean;
    composeRendered: boolean;
    hostControlConfigured: boolean;
    maintenanceReady: boolean;
  };
  images: ImageStatus[];
}

interface TrackedJob {
  id: string;
  label: string;
}

interface JobStatus {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  progress: number | null;
  error: string | null;
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
  if (image.status === "update-available") return <Chip color="warning" label="Update ready" />;
  if (image.status === "up-to-date") {
    return <Chip color="success" variant="outlined" label="Up to date" />;
  }
  if (image.status === "not-running") return <Chip label="Not running" />;
  return <Chip color="warning" variant="outlined" label="Unknown" />;
}

export function SystemMaintenance() {
  const { apiUrl } = useEnv();
  const queryClient = useQueryClient();
  const showToast = useAdminToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [createBackup, setCreateBackup] = useState(true);
  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);

  const statusQuery = useQuery<SystemStatus>({
    queryKey: ["admin", "system"],
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/admin/system`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to load system maintenance status");
      return response.json();
    },
    refetchInterval: trackedJob ? 5_000 : false,
  });

  const jobQuery = useQuery<JobStatus>({
    queryKey: ["admin", "jobs", trackedJob?.id],
    enabled: Boolean(trackedJob),
    queryFn: async () => {
      const response = await fetch(`${apiUrl}/api/admin/jobs/${trackedJob?.id}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to read maintenance job");
      return response.json();
    },
    refetchInterval: trackedJob ? 3_000 : false,
    retry: true,
  });

  useEffect(() => {
    const job = jobQuery.data;
    if (!trackedJob || !job || !["success", "failed", "canceled"].includes(job.status)) return;
    if (job.status === "success") showToast(`${trackedJob.label} completed`);
    else showToast(job.error || `${trackedJob.label} ${job.status}`, "error");
    void queryClient.invalidateQueries({ queryKey: ["admin", "system"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    setTrackedJob(null);
  }, [jobQuery.data, queryClient, showToast, trackedJob]);

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
      return { id: result.jobId, label };
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
        description="Checking pulls current image tags into the local cache without restarting anything."
        toolbar={
          <Stack
            direction={{ xs: "column", sm: "row" }}
            sx={{ gap: 1, alignItems: { sm: "center" } }}
          >
            {updateCount > 0 && <Chip color="warning" label={`${updateCount} update ready`} />}
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
              disabled={active || !status?.deployment.maintenanceReady || updateCount === 0}
              title={updateCount === 0 ? "All core images are up to date" : undefined}
              onClick={() => setDialogOpen(true)}
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
            <Alert severity="info">
              Images are pulled before any container is replaced. Data Manager and Web update first;
              API updates last and briefly interrupts this page.
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
            disabled={confirmation !== CONFIRMATION || queueJob.isPending || updateCount === 0}
            onClick={() => {
              queueJob.mutate({
                path: "updates/apply",
                body: { confirmation, createBackup },
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
