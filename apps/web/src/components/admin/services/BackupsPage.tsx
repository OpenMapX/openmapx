"use client";

import DeleteIcon from "@mui/icons-material/Delete";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestoreIcon from "@mui/icons-material/Restore";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
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
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { serviceAdminQueries, serviceOrThrow } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationKey, useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
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
  const t = useTranslations("adminServices");
  const { client, apiUrl } = useActivityClient();
  const register = useServiceJobRegistration();
  const showToast = useAdminToast();
  const [lastAcceptedJobId, setLastAcceptedJobId] = useState<string | null>(null);
  const createIntent = useAdminMutationKey(client),
    restoreIntent = useAdminMutationKey(client),
    deleteIntent = useAdminMutationKey(client);

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
      const key = createIntent.forIntent(name.trim());
      try {
        const result = await serviceOrThrow(
          sdk.createAdminServiceBackup(
            { "idempotency-key": key },
            { name: name.trim() || undefined },
            { client },
          ),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) setLastAcceptedJobId(result.jobId);
        if (execution.active) {
          showToast(t("backupCreateQueuedJobid", { jobId: result.jobId }));
          setCreateName("");
        }
        createIntent.complete(key);
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("backupCreateFailed"), "error");
        throw error;
      }
    },
  });
  const restoreMutation = useMutation({
    retry: false,
    mutationFn: async (payload: { name: string; serviceIds: string[]; stopRunning: boolean }) => {
      const execution = dialogOwner;
      const effect = { kind: "backups" } as const;
      const key = restoreIntent.forIntent(JSON.stringify([dialogGeneration, payload]));
      try {
        const result = await serviceOrThrow(
          sdk.restoreAdminServiceBackup(
            payload.name,
            { "idempotency-key": key },
            { serviceIds: payload.serviceIds, stopRunning: payload.stopRunning },
            { client },
          ),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) setLastAcceptedJobId(result.jobId);
        if (execution.active) {
          showToast(t("restoreQueuedForNameJobid", { name: payload.name, jobId: result.jobId }));
          setRestoreTarget(null);
          setRestoreServiceIds("");
          setRestoreStopRunning(false);
        }
        restoreIntent.complete(key);
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("restoreFailed"), "error");
        throw error;
      }
    },
  });
  const deleteMutation = useMutation({
    retry: false,
    mutationFn: async (name: string) => {
      const execution = dialogOwner;
      const effect = { kind: "backups" } as const;
      const key = deleteIntent.forIntent(JSON.stringify([dialogGeneration, name]));
      try {
        const result = await serviceOrThrow(
          sdk.deleteAdminServiceBackup(name, { "idempotency-key": key }, undefined, { client }),
        );
        register({ client, apiUrl, jobId: result.jobId, effect });
        if (execution.active) setLastAcceptedJobId(result.jobId);
        if (execution.active) {
          showToast(t("deleteQueuedForNameJobid", { name, jobId: result.jobId }));
          setDeleteTarget(null);
        }
        deleteIntent.complete(key);
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("deleteFailed"), "error");
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
        title={t("backups")}
        subtitle={t("createRestoreAndDeleteService")}
        actions={
          <Tooltip title={t("refresh")}>
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
            label={t("backupNameOptional")}
            size="small"
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder={t("eGPreUpgrade2026")}
            sx={{ minWidth: { xs: "100%", sm: 320 } }}
          />
          <Button
            variant="contained"
            size="small"
            onClick={() => createMutation.mutate(createName)}
            disabled={createMutation.isPending}
          >
            {createMutation.isPending ? t("queueing") : t("createBackup")}
          </Button>
          <Button
            component={Link}
            href={
              lastAcceptedJobId
                ? adminJobHref({ id: lastAcceptedJobId, source: "application" })
                : "/admin/activity"
            }
            size="small"
            variant="outlined"
          >
            {t("openActivity2")}
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
          {t("allowedLettersNumbersDotDash")}
        </Typography>
      </Paper>
      {data && (
        <Typography variant="caption">{t("backupStorageRoot", { root: data.root })}</Typography>
      )}
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
      {isError && <Alert severity="error">{t("failedToLoadBackups")}</Alert>}
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
                  placeholder={t("searchBackupsByName")}
                />
                <FormControl size="small" sx={{ minWidth: 150 }}>
                  <Select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                  >
                    <MenuItem value="all">{t("allBackups")}</MenuItem>
                    <MenuItem value="valid">{t("valid")}</MenuItem>
                    <MenuItem value="corrupt">{t("corrupt")}</MenuItem>
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
                  <TableCell>{t("name")}</TableCell>
                  <TableCell>{t("created")}</TableCell>
                  <TableCell>{t("version")}</TableCell>
                  <TableCell>{t("services")}</TableCell>
                  <TableCell>{t("volumes")}</TableCell>
                  <TableCell>{t("size")}</TableCell>
                  <TableCell align="right">{t("actions")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmptyState
                    colSpan={7}
                    message={
                      sortedBackups.length === 0
                        ? t("noBackupsFoundYet")
                        : t("noBackupsMatchYourSearch")
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
                              title={t("cannotBeRestoredValue", {
                                value: backup.corruptReason ?? t("manifestMissing"),
                              })}
                            >
                              <Chip
                                label={t("corrupt2")}
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
                            {t("expiresExpiresat", {
                              expiresAt: new Date(backup.expiresAt).toLocaleString(),
                            })}
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
                                ? t("corruptBackupCannotBeRestored")
                                : backup.expiresAt && Date.parse(backup.expiresAt) < Date.now()
                                  ? t("expiredBackupCannotBeRestored")
                                  : t("restoreBackup")
                            }
                          >
                            <span>
                              <IconButton
                                size="small"
                                color="primary"
                                aria-label={t("restoreBackup")}
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
                          <Tooltip title={t("deleteBackup")}>
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={t("deleteBackup")}
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
        <DialogTitle>{t("restoreBackup2")}</DialogTitle>
        <DialogContent>
          <Stack
            sx={{
              gap: 2,
              pt: 0.5,
            }}
          >
            <Alert severity="warning">{t("restoringOverwritesCurrentServiceData")}</Alert>
            <Typography variant="body2">
              {t("backup")}
              <strong>{restoreTarget?.name}</strong>
            </Typography>
            <TextField
              label={t("serviceIdsOptional")}
              placeholder={t("valhallaOsrmMotis")}
              size="small"
              value={restoreServiceIds}
              onChange={(e) => setRestoreServiceIds(e.target.value)}
              helperText={t("commaSeparatedListLeaveEmpty")}
              fullWidth
            />
            <FormControlLabel
              control={
                <Switch
                  checked={restoreStopRunning}
                  onChange={(e) => setRestoreStopRunning(e.target.checked)}
                />
              }
              label={t("stopCurrentlyRunningTargetServices")}
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
            {t("cancel")}
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
            {restoreMutation.isPending ? t("queueing2") : t("restore")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t("deleteBackup2")}</DialogTitle>
        <DialogContent>
          <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
            {t("thisCannotBeUndone")}
          </Alert>
          <Typography variant="body2">
            {t.rich("deleteBackupName", {
              name: deleteTarget?.name ?? "",
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
            {t("cancel")}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteMutation.isPending || !deleteTarget}
            onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.name)}
          >
            {deleteMutation.isPending ? t("queueing2") : t("delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
