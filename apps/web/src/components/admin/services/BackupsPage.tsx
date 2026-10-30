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
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { AdminServiceBackup } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import { serviceAdminQueries, serviceOrThrow } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { formatBytes } from "@/lib/storageFormat";
import { useActivityClient } from "../activity/activityQueries";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useClientPagination, useTextFilter } from "../shared/tableHooks";
import { BackupPruneControls } from "./BackupPruneControls";

function parseServiceIds(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function BackupsPage() {
  const { apiUrl } = useActivityClient();
  return <BackupsView key={apiUrl} />;
}
function BackupsView() {
  const { client, apiUrl } = useActivityClient();
  const register = useServiceJobRegistration();
  const showToast = useAdminToast();

  const [createName, setCreateName] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<AdminServiceBackup | null>(null);
  const [restoreServiceIds, setRestoreServiceIds] = useState("");
  const [restoreStopRunning, setRestoreStopRunning] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AdminServiceBackup | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "valid" | "corrupt">("all");

  const [dialogGeneration, setDialogGeneration] = useState(0);
  const createOwner = useAdminMutationOwner(client, createName);
  const dialogOwner = useAdminMutationOwner(
    client,
    JSON.stringify([
      dialogGeneration,
      restoreTarget?.name,
      deleteTarget?.name,
      restoreServiceIds,
      restoreStopRunning,
    ]),
  );
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    ...serviceAdminQueries(client, apiUrl).backups(),
    refetchInterval: 60_000,
  });
  const createMutation = useMutation({
    retry: false,
    mutationFn: async (name: string) => {
      const execution = createOwner;
      const effect = { kind: "backups" } as const;
      try {
        const result = await serviceOrThrow(
          sdk.createAdminServiceBackup({ name: name.trim() || undefined }, { client }),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) {
          showToast(`Backup create queued (${result.jobId})`);
          setCreateName("");
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Backup create failed", "error");
        throw error;
      }
    },
  });
  const restoreMutation = useMutation({
    retry: false,
    mutationFn: async (payload: { name: string; serviceIds: string[]; stopRunning: boolean }) => {
      const execution = dialogOwner;
      const effect = { kind: "backups" } as const;
      try {
        const result = await serviceOrThrow(
          sdk.restoreAdminServiceBackup(
            payload.name,
            { serviceIds: payload.serviceIds, stopRunning: payload.stopRunning },
            { client },
          ),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) {
          showToast(`Restore queued for ${payload.name} (${result.jobId})`);
          setRestoreTarget(null);
          setRestoreServiceIds("");
          setRestoreStopRunning(false);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Restore failed", "error");
        throw error;
      }
    },
  });
  const deleteMutation = useMutation({
    retry: false,
    mutationFn: async (name: string) => {
      const execution = dialogOwner;
      const effect = { kind: "backups" } as const;
      try {
        const result = await serviceOrThrow(
          sdk.deleteAdminServiceBackup(name, undefined, { client }),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) {
          showToast(`Delete queued for ${name} (${result.jobId})`);
          setDeleteTarget(null);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Delete failed", "error");
        throw error;
      }
    },
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
        gap: 2,
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
            {createMutation.isPending ? "Queueing…" : "Create backup"}
          </Button>
          <Button component={Link} href="/admin/activity" size="small" variant="outlined">
            Open activity
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
      {data && <Typography variant="caption">Backup storage: {data.root}</Typography>}
      <BackupPruneControls />
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
        <AdminTableSurface
          toolbar={
            sortedBackups.length > 0 ? (
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
            ) : undefined
          }
          pagination={<AdminTablePagination {...paginationProps} />}
        >
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
                      <TableCell>
                        {new Date(backup.createdAt).toLocaleString()}
                        {backup.expiresAt && (
                          <Typography variant="caption" sx={{ display: "block" }}>
                            Expires {new Date(backup.expiresAt).toLocaleString()}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        {backup.corrupt ? "—" : (backup.openmapxVersion ?? "—")}
                      </TableCell>
                      <TableCell>{backup.corrupt ? "—" : backup.serviceCount}</TableCell>
                      <TableCell>{backup.corrupt ? "—" : backup.volumeCount}</TableCell>
                      <TableCell>{backup.corrupt ? "—" : formatBytes(backup.totalBytes)}</TableCell>
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
                                : backup.expiresAt && Date.parse(backup.expiresAt) < Date.now()
                                  ? "Expired backup — cannot be restored"
                                  : "Restore backup"
                            }
                          >
                            <span>
                              <IconButton
                                size="small"
                                color="primary"
                                aria-label="Restore backup"
                                onClick={() => {
                                  restoreMutation.reset();
                                  setDialogGeneration((n) => n + 1);
                                  setRestoreServiceIds("");
                                  setRestoreStopRunning(false);
                                  setRestoreTarget(backup);
                                }}
                                disabled={
                                  backup.corrupt ||
                                  !!(backup.expiresAt && Date.parse(backup.expiresAt) < Date.now())
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
                                aria-label="Delete backup"
                                onClick={() => {
                                  deleteMutation.reset();
                                  setDialogGeneration((n) => n + 1);
                                  setDeleteTarget(backup);
                                }}
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
        </AdminTableSurface>
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
