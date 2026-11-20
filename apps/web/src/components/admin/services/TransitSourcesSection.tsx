"use client";

import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { createApiClient, safeHref } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { TransitSource } from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import type { AdminTranslator } from "@/lib/admin/adminTranslator";
import { formatBytes } from "@/lib/storageFormat";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useServerPagination } from "../shared/tableHooks";
import { TransitSyncDialog } from "./TransitSyncDialog";

export type { TransitSource };

export function sourceStateLabel(source: TransitSource, t: AdminTranslator): string {
  if (source.desiredState === "removed")
    return source.active ? t("sourceRemovedPendingSync") : t("sourceRemoved");
  if (source.desiredState === "disabled" && source.active) return t("sourceDisabledPendingSync");
  if (source.lifecycle === "removal-pending") return t("sourceRemovalPending");
  if (source.lifecycle === "update-pending") return t("sourceUpdatePending");
  if (source.lifecycle === "add-pending") return t("sourceAddPending");
  if (!source.requested && source.active) return t("sourceNotRequestedActive");
  if (source.requested && !source.active && source.lifecycle === "failed") {
    return t("sourceRequestedFailed");
  }
  if (source.requested && source.active) return t("sourceRequestedActive");
  return t("sourceDisabled");
}

function stateColor(
  lifecycle: TransitSource["lifecycle"],
): "default" | "success" | "warning" | "error" | "info" {
  if (lifecycle === "active") return "success";
  if (lifecycle === "failed") return "error";
  if (lifecycle === "stale") return "warning";
  if (lifecycle.endsWith("-pending")) return "info";
  return "default";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TransitSourcesSection({ apiUrl }: { apiUrl: string }) {
  return <TransitSourcesView key={apiUrl} apiUrl={apiUrl} />;
}
function TransitSourcesView({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminServices");
  const queryClient = useQueryClient();
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [removing, setRemoving] = useState<TransitSource | null>(null);
  const identities = useRef(new Map<string, string>());
  const operationId = (intent: unknown) => {
    const fingerprint = JSON.stringify(intent);
    let key = identities.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      if (identities.current.size >= 128)
        identities.current.delete(identities.current.keys().next().value!);
      identities.current.set(fingerprint, key);
    }
    return key;
  };
  const [toast, setToast] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [syncDialogOpen, setSyncDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [licenseSpdx, setLicenseSpdx] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const catalogPagination = useServerPagination(50);
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const [query, setSearch] = useState("");
  const pagination = useServerPagination(50);
  const setQuery = (value: string) => {
    setSearch(value);
    pagination.setPage(0);
  };
  const sourcesQuery = useQuery({
    queryKey: [
      "admin",
      "transit",
      apiUrl,
      "sources",
      query.trim(),
      pagination.offset,
      pagination.rowsPerPage,
    ],
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.getApiDataManagerTransitSources(
          {
            search: query.trim() || undefined,
            limit: pagination.rowsPerPage,
            offset: pagination.offset,
          },
          { client, signal },
        ),
      ),
    refetchInterval: 30_000,
  });
  const stateQuery = useQuery({
    queryKey: ["admin", "transit", apiUrl, "state"],
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(await sdk.getApiDataManagerTransitState({ client, signal })),
    refetchInterval: 10_000,
  });
  const catalogQuery = useQuery({
    queryKey: [
      "admin",
      "transit",
      apiUrl,
      "catalog",
      catalogSearch,
      catalogPagination.offset,
      catalogPagination.rowsPerPage,
    ],
    enabled: dialogOpen && catalogSearch.trim().length >= 2,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.getApiDataManagerTransitCatalog(
          {
            search: catalogSearch.trim(),
            limit: catalogPagination.rowsPerPage,
            offset: catalogPagination.offset,
          },
          { client, signal },
        ),
      ),
  });

  const reportJob = (jobId: string, message: string) => {
    setLastJobId(jobId);
    setToast(message);
    void queryClient.invalidateQueries({ queryKey: ["admin", "transit", apiUrl] });
  };
  const addMutation = useMutation({
    retry: false,
    mutationFn: async () =>
      sdk.unwrapAdminResponse(
        await sdk.postApiDataManagerTransitSources(
          {
            expectedSourceRevision: sourcesQuery.data!.sourceRevision,
            idempotencyKey: operationId({
              action: "add",
              url,
              name,
              region,
              licenseSpdx,
              licenseUrl,
              attribution,
              revision: sourcesQuery.data?.sourceRevision,
            }),
            url: url.trim(),
            name: name.trim(),
            region: region.trim(),
            license: {
              attribution: attribution.trim(),
              ...(licenseSpdx.trim() ? { spdxIdentifier: licenseSpdx.trim() } : {}),
              ...(licenseUrl.trim() ? { url: licenseUrl.trim() } : {}),
            },
          },
          { client },
        ),
      ),
    onSuccess: ({ jobId }) => {
      reportJob(jobId, t("sourceChangeQueued", { jobId }));
      setDialogOpen(false);
      setUrl("");
      setName("");
      setRegion("");
      setLicenseSpdx("");
      setLicenseUrl("");
      setAttribution("");
    },
    onError: (error) => setToast(adminErrorText(error, t("serviceRequestFailed"))),
  });
  const sourceMutation = useMutation({
    retry: false,
    mutationFn: async ({
      sourceId,
      action,
      revision,
    }: {
      sourceId: string;
      action: "enable" | "disable" | "remove";
      revision: string;
    }) => {
      const body = {
        expectedSourceRevision: revision,
        idempotencyKey: operationId({ sourceId, action, revision }),
      };
      return sdk.unwrapAdminResponse(
        await (action === "remove"
          ? sdk.deleteApiDataManagerTransitSourcesSourceId(sourceId, body, { client })
          : action === "disable"
            ? sdk.postApiDataManagerTransitSourcesSourceIdDisable(sourceId, body, { client })
            : sdk.postApiDataManagerTransitSourcesSourceIdEnable(sourceId, body, { client })),
      );
    },
    onSuccess: ({ jobId, sourceId }) => {
      setRemoving(null);
      reportJob(jobId, t("sourceActionQueued", { sourceId, jobId }));
    },
    onError: (error) => setToast(adminErrorText(error, t("serviceRequestFailed"))),
  });

  const sources = sourcesQuery.data?.sources ?? [];
  const paged = sources;
  const paginationProps = { ...pagination.paginationProps, count: sourcesQuery.data?.total ?? 0 };
  const syncJob = stateQuery.data?.currentJob ?? null;
  const mutationPending = addMutation.isPending || sourceMutation.isPending || syncDialogOpen;
  const actionsDisabled = syncJob !== null || mutationPending;
  const disabledReason = syncJob
    ? t("transitSyncJobidIsActive2", { jobId: syncJob.jobId })
    : mutationPending
      ? t("aSourceChangeIsBeing")
      : "";
  const addValid =
    url.trim() !== "" &&
    name.trim() !== "" &&
    region.trim() !== "" &&
    attribution.trim() !== "" &&
    (licenseSpdx.trim() !== "" || licenseUrl.trim() !== "");

  return (
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        spacing={1}
        sx={{ alignItems: { xs: "stretch", md: "center" }, mb: 2 }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <StorageIcon color="primary" />
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            {t("transitSources")}
          </Typography>
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Button component={Link} href="/admin/activity" variant="outlined" size="small">
            {t("activity")}
          </Button>
          <Tooltip title={disabledReason} disableHoverListener={!actionsDisabled}>
            <span>
              <Button
                variant="outlined"
                size="small"
                disabled={actionsDisabled}
                onClick={() => setSyncDialogOpen(true)}
              >
                {t("syncSources")}
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={disabledReason} disableHoverListener={!actionsDisabled}>
            <span>
              <Button
                variant="contained"
                size="small"
                disabled={actionsDisabled || !sourcesQuery.data}
                onClick={() => setDialogOpen(true)}
              >
                {t("addSource")}
              </Button>
            </span>
          </Tooltip>
        </Stack>
      </Stack>
      {(syncJob || lastJobId) && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button
              component={Link}
              href={adminJobHref({ id: syncJob?.jobId ?? lastJobId ?? "", source: "data-manager" })}
              size="small"
              color="inherit"
            >
              {t("viewJob")}
            </Button>
          }
        >
          {syncJob
            ? t("transitSyncJobidIsActive", { jobId: syncJob.jobId })
            : t("sourceChangeQueuedAsLastjobid", { lastJobId: lastJobId ?? "" })}
        </Alert>
      )}
      {syncDialogOpen && (
        <TransitSyncDialog
          apiUrl={apiUrl}
          onClose={() => setSyncDialogOpen(false)}
          onQueued={(jobId) => {
            setSyncDialogOpen(false);
            reportJob(jobId, t("transitSyncQueued", { jobId }));
          }}
        />
      )}
      <Dialog
        open={dialogOpen}
        onClose={addMutation.isPending ? undefined : () => setDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t("addTransitSource")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Alert severity="info">{t("theCurrentMotisDatasetRemains")}</Alert>
            <TextField
              label={t("scheduleUrl")}
              placeholder={t("httpsExampleComFeedGtfs")}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
              fullWidth
              size="small"
            />
            <TextField
              label={t("safeDisplayName")}
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              label={t("region")}
              placeholder={t("deBe")}
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              label={t("attribution")}
              multiline
              minRows={2}
              value={attribution}
              onChange={(event) => setAttribution(event.target.value)}
              fullWidth
              size="small"
            />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                label={t("spdxLicense")}
                placeholder={t("ccBy40")}
                value={licenseSpdx}
                onChange={(event) => setLicenseSpdx(event.target.value)}
                fullWidth
                size="small"
              />
              <TextField
                label={t("licenseUrl")}
                value={licenseUrl}
                onChange={(event) => setLicenseUrl(event.target.value)}
                fullWidth
                size="small"
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {t("provideAnSpdxIdentifierOr")}
            </Typography>
            <TextField
              label={t("searchInstalledCatalogOptional")}
              value={catalogSearch}
              onChange={(event) => {
                setCatalogSearch(event.target.value);
                catalogPagination.setPage(0);
              }}
              fullWidth
              size="small"
            />
            {catalogQuery.error && (
              <Alert severity="error">
                {adminErrorText(catalogQuery.error, t("serviceRequestFailed"))}
              </Alert>
            )}
            {catalogQuery.data?.sources.map((source) => (
              <Button
                key={source.id}
                variant="text"
                sx={{ justifyContent: "flex-start" }}
                disabled={actionsDisabled}
                onClick={() => {
                  if (source.installedSourceId) {
                    if (sourcesQuery.data)
                      sourceMutation.mutate({
                        sourceId: source.installedSourceId,
                        action: "enable",
                        revision: sourcesQuery.data.sourceRevision,
                      });
                    setDialogOpen(false);
                  } else {
                    setUrl(source.url);
                    setName(source.name);
                    setRegion(source.countryCode);
                    const bindings = source.licensing?.bindings ?? [],
                      license = bindings.length === 1 ? bindings[0]?.license : undefined;
                    setLicenseSpdx(license?.kind === "spdx" ? license.expression : "");
                    setLicenseUrl(license?.url ?? "");
                    setAttribution(
                      bindings
                        .flatMap((binding) => [
                          binding.subject,
                          binding.notice,
                          ...(binding.conditions ?? []),
                        ])
                        .filter(Boolean)
                        .join("\n"),
                    );
                  }
                }}
              >
                {source.installedSourceId ? t("enable") : t("use")} {source.name} (
                {source.countryCode})
              </Button>
            ))}
            <AdminTablePagination
              {...catalogPagination.paginationProps}
              count={catalogQuery.data?.total ?? 0}
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={addMutation.isPending}>
            {t("cancel")}
          </Button>
          <Button
            variant="contained"
            disabled={!addValid || !sourcesQuery.data}
            onClick={() => addMutation.mutate()}
          >
            {addMutation.isPending ? t("queueing") : t("addAndSync")}
          </Button>
        </DialogActions>
      </Dialog>
      <Box sx={{ mb: 2 }}>
        <TableToolbar>
          <TableSearchField
            value={query}
            onChange={setQuery}
            placeholder={t("searchSourcesByNameRegion")}
          />
        </TableToolbar>
      </Box>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 960 }}>
          <TableHead>
            <TableRow>
              <TableCell>{t("source")}</TableCell>
              <TableCell>{t("origin")}</TableCell>
              <TableCell>{t("state")}</TableCell>
              <TableCell>{t("formatSize")}</TableCell>
              <TableCell>{t("validation")}</TableCell>
              <TableCell>{t("lastFetched")}</TableCell>
              <TableCell>{t("lastPromoted")}</TableCell>
              <TableCell align="right">{t("actions")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sourcesQuery.isError ? (
              <TableEmptyState colSpan={8} message={t("failedToLoadTransitSources")} />
            ) : paged.length === 0 ? (
              <TableEmptyState colSpan={8} message={t("noTransitSourcesMatch")} />
            ) : (
              paged.map((source) => (
                <TableRow key={source.id} hover>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <Typography variant="body2">{source.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {source.id} · {source.region}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <Chip label={source.origin} size="small" variant="outlined" />
                      {source.originUrl && (
                        <Tooltip title={source.originUrl}>
                          <Typography
                            component="a"
                            href={safeHref(source.originUrl)}
                            target="_blank"
                            rel="noreferrer noopener"
                            variant="caption"
                            color="text.secondary"
                            sx={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}
                          >
                            {source.originUrl}
                          </Typography>
                        </Tooltip>
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Chip
                      label={sourceStateLabel(source, t)}
                      size="small"
                      color={stateColor(source.lifecycle)}
                    />
                  </TableCell>
                  <TableCell>
                    {source.format.toUpperCase()}
                    {source.artifact
                      ? t("sizebytes", { sizeBytes: formatBytes(source.artifact.sizeBytes) })
                      : ""}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={source.validationMessage ?? ""}>
                      <span>{source.validationStatus ?? t("notValidated")}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {source.lastFetchedAt ? formatDate(source.lastFetchedAt) : "—"}
                  </TableCell>
                  <TableCell>
                    {source.lastImportedAt ? formatDate(source.lastImportedAt) : "—"}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title={disabledReason || source.actions.reason || ""}>
                      <span>
                        <Button
                          size="small"
                          disabled={
                            actionsDisabled ||
                            !(source.requested ? source.actions.disable : source.actions.enable)
                          }
                          onClick={() =>
                            sourceMutation.mutate({
                              sourceId: source.id,
                              action: source.requested ? "disable" : "enable",
                              revision: source.sourceRevision,
                            })
                          }
                        >
                          {source.requested ? t("disable") : t("enable")}
                        </Button>
                      </span>
                    </Tooltip>
                    {source.actions.remove && (
                      <Button
                        size="small"
                        color="error"
                        disabled={actionsDisabled}
                        onClick={() => setRemoving(source)}
                      >
                        {t("remove")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <AdminTablePagination {...paginationProps} />
      <ConfirmDialog
        open={!!removing}
        title={t("removeTransitSource")}
        message={t("removeValueItsSavedUrl", { value: removing?.name ?? "" })}
        confirmLabel={t("removeSource")}
        confirmColor="error"
        loading={sourceMutation.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing && !sourceMutation.isPending)
            sourceMutation.mutate({
              sourceId: removing.id,
              action: "remove",
              revision: removing.sourceRevision,
            });
        }}
      />
      <Snackbar
        open={toast !== null}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Paper>
  );
}
