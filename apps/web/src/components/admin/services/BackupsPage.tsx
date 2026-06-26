"use client";

import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestoreIcon from "@mui/icons-material/Restore";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { formatBytes } from "@/lib/storageFormat";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { useAdminToast } from "../shared/AdminToast";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useClientPagination, useTextFilter } from "../shared/tableHooks";

interface BackupSummary {
  name: string;
  createdAt: string;
  openmapxVersion?: string;
  services: number;
  volumes: number;
  totalBytes: number;
  corrupt?: boolean;
  corruptReason?: string;
}

interface BackupsResponse {
  backups: BackupSummary[];
  warnings: string[];
  root: string;
}

function parseServiceIds(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function BackupsPage() {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const showToast = useAdminToast();

  const [createName, setCreateName] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<BackupSummary | null>(null);
  const [restoreServiceIds, setRestoreServiceIds] = useState("");
  const [restoreStopRunning, setRestoreStopRunning] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupSummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "corrupt">("all");

  const { data, isLoading, isError, refetch, isFetching } = useQuery<BackupsResponse>({
    queryKey: ["admin", "services", "backups"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/backups`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load backups");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const createMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`${apiUrl}/api/admin/services/backups`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to queue backup create");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: ({ jobId }) => {
      showToast(`Backup create queued (${jobId})`);
      setCreateName("");
      qc.invalidateQueries({ queryKey: ["admin", "services", "backups"] });
      qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onError: (err) =>
      showToast(err instanceof Error ? err.message : "Backup create failed", "error"),
  });

  const restoreMutation = useMutation({
    mutationFn: async (payload: { name: string; serviceIds: string[]; stopRunning: boolean }) => {
      const res = await fetch(
        `${apiUrl}/api/admin/services/backups/${encodeURIComponent(payload.name)}/restore`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            serviceIds: payload.serviceIds,
            stopRunning: payload.stopRunning,
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to queue backup restore");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: ({ jobId }, vars) => {
      showToast(`Restore queued for ${vars.name} (${jobId})`);
      setRestoreTarget(null);
      setRestoreServiceIds("");
      setRestoreStopRunning(false);
      qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Restore failed", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`${apiUrl}/api/admin/services/backups/${encodeURIComponent(name)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to queue backup delete");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: ({ jobId }, name) => {
      showToast(`Delete queued for ${name} (${jobId})`);
      setDeleteTarget(null);
      qc.invalidateQueries({ queryKey: ["admin", "services", "backups"] });
      qc.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Delete failed", "error"),
  });

  const sortedBackups = [...(data?.backups ?? [])].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const { query, setQuery, filtered: searched } = useTextFilter(sortedBackups, (b) => b.name);
  const filtered = useMemo(
    () =>
      searched.filter(
        (b) => statusFilter === "all" || (statusFilter === "corrupt" ? !!b.corrupt : !b.corrupt),
      ),
    [searched, statusFilter],
  );
  const { paged, paginationProps } = useClientPagination(filtered);

  return (
    <Stack
      sx={{
        gap: 3,
      }}
    >
      <AdminPageHeader
        title="Backups"
        subtitle="Create, restore, and delete service-volume backups"
        actions={
          <Tooltip title="Refresh">
            <span>
              <IconButton onClick={() => refetch()} disabled={isFetching || isLoading}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        }
      />
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          sx={{
            alignItems: { sm: "center" },
          }}
        >
          <TextField
            label="Backup name (optional)"
            size="small"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="e.g. pre-upgrade-2026-04-21"
            sx={{ minWidth: { xs: "100%", sm: 320 } }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={() => createMutation.mutate(createName)}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? "Queueing..." : "Create Backup"}
          </Button>
          <Button component={Link} href="/admin/activity" size="small" variant="outlined">
            Open Activity
          </Button>
        </Stack>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            mt: 1,
            display: "block",
          }}
        >
          Allowed: letters, numbers, dot, dash, underscore.
        </Typography>
      </Paper>
      {isLoading && (
        <Box
          sx={{
            py: 6,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <CircularProgress />
        </Box>
      )}
      {isError && <Alert severity="error">Failed to load backups.</Alert>}
      {!!data?.warnings.length && (
        <Alert severity="warning">
          {data.warnings.map((warning) => (
            <Typography key={warning} variant="body2">
              {warning}
            </Typography>
          ))}
        </Alert>
      )}
      {!isLoading && !isError && (
        <>
          {sortedBackups.length > 0 && (
            <TableToolbar>
              <TableSearchField
                value={query}
                onChange={setQuery}
                placeholder="Search backups by name…"
              />
              <FormControl size="small" sx={{ minWidth: 150 }}>
                <Select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                >
                  <MenuItem value="all">All backups</MenuItem>
                  <MenuItem value="valid">Valid</MenuItem>
                  <MenuItem value="corrupt">Corrupt</MenuItem>
                </Select>
              </FormControl>
            </TableToolbar>
          )}
          <Paper variant="outlined">
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Created</TableCell>
                    <TableCell>Version</TableCell>
                    <TableCell>Services</TableCell>
                    <TableCell>Volumes</TableCell>
                    <TableCell>Size</TableCell>
                    <TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmptyState
                      colSpan={7}
                      message={
                        sortedBackups.length === 0
                          ? "No backups found yet."
                          : "No backups match your search or filter."
                      }
                    />
                  ) : (
                    paged.map((backup) => (
                      <TableRow key={backup.name} hover>
                        <TableCell>
                          <Stack
                            direction="row"
                            sx={{
                              alignItems: "center",
                              gap: 1,
                              flexWrap: "wrap",
                            }}
                          >
                            <Typography
                              variant="body2"
                              sx={{
                                fontFamily: "monospace",
                                fontWeight: 600,
                              }}
                            >
                              {backup.name}
                            </Typography>
                            {backup.corrupt && (
                              <Tooltip
                                title={`Cannot be restored: ${backup.corruptReason ?? "manifest is missing or malformed"}`}
                              >
                                <Chip
                                  label="corrupt"
                                  size="small"
                                  color="warning"
                                  variant="outlined"
                                />
                              </Tooltip>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>{new Date(backup.createdAt).toLocaleString()}</TableCell>
                        <TableCell>
                          {backup.corrupt ? "—" : (backup.openmapxVersion ?? "—")}
                        </TableCell>
                        <TableCell>{backup.corrupt ? "—" : backup.services}</TableCell>
                        <TableCell>{backup.corrupt ? "—" : backup.volumes}</TableCell>
                        <TableCell>
                          {backup.corrupt ? "—" : formatBytes(backup.totalBytes)}
                        </TableCell>
                        <TableCell align="right">
                          <Stack
                            direction="row"
                            spacing={0.5}
                            sx={{
                              justifyContent: "flex-end",
                            }}
                          >
                            <Tooltip
                              title={
                                backup.corrupt
                                  ? "Corrupt backup — cannot be restored"
                                  : "Restore backup"
                              }
                            >
                              <span>
                                <IconButton
                                  size="small"
                                  color="primary"
                                  onClick={() => setRestoreTarget(backup)}
                                  disabled={
                                    backup.corrupt ||
                                    restoreMutation.isPending ||
                                    deleteMutation.isPending
                                  }
                                >
                                  <RestoreIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                            <Tooltip title="Delete backup">
                              <span>
                                <IconButton
                                  size="small"
                                  color="error"
                                  onClick={() => setDeleteTarget(backup)}
                                  disabled={restoreMutation.isPending || deleteMutation.isPending}
                                >
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            <AdminTablePagination {...paginationProps} />
          </Paper>
        </>
      )}
      <Dialog open={!!restoreTarget} onClose={() => setRestoreTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Restore Backup</DialogTitle>
        <DialogContent>
          <Stack
            sx={{
              gap: 2,
              pt: 0.5,
            }}
          >
            <Alert severity="warning">
              Restoring overwrites current service data for selected targets.
            </Alert>
            <Typography variant="body2">
              Backup: <strong>{restoreTarget?.name}</strong>
            </Typography>
            <TextField
              label="Service IDs (optional)"
              placeholder="valhalla, osrm, motis"
              size="small"
              value={restoreServiceIds}
              onChange={(e) => setRestoreServiceIds(e.target.value)}
              helperText="Comma-separated list. Leave empty to restore all services from this backup."
              fullWidth
            />
            <FormControlLabel
              control={
                <Switch
                  checked={restoreStopRunning}
                  onChange={(e) => setRestoreStopRunning(e.target.checked)}
                />
              }
              label="Stop currently running target services before restore"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setRestoreTarget(null);
              setRestoreServiceIds("");
              setRestoreStopRunning(false);
            }}
            disabled={restoreMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={restoreMutation.isPending || !restoreTarget}
            onClick={() => {
              if (!restoreTarget) return;
              restoreMutation.mutate({
                name: restoreTarget.name,
                serviceIds: parseServiceIds(restoreServiceIds),
                stopRunning: restoreStopRunning,
              });
            }}
          >
            {restoreMutation.isPending ? "Queueing..." : "Restore"}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Backup</DialogTitle>
        <DialogContent>
          <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
            This cannot be undone.
          </Alert>
          <Typography variant="body2">
            Delete backup <strong>{deleteTarget?.name}</strong>?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteMutation.isPending || !deleteTarget}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.name)}
          >
            {deleteMutation.isPending ? "Queueing..." : "Delete"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
