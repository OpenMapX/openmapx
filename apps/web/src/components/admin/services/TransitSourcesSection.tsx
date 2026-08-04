"use client";

import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
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
import { safeHref } from "@openmapx/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { formatBytes } from "@/lib/storageFormat";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { useClientPagination, useTextFilter } from "../shared/tableHooks";

export interface TransitSource {
  id: string;
  region: string;
  name: string;
  format: "gtfs" | "netex";
  origin: "catalog" | "operator";
  originUrl?: string;
  requested: boolean;
  active: boolean;
  activeEpoch?: string;
  artifact?: { sizeBytes: number; retrievedAt: string };
  lastFetchedAt?: string;
  lastImportedAt?: string;
  validationStatus?: string;
  validationMessage?: string;
  lifecycle:
    | "active"
    | "add-pending"
    | "update-pending"
    | "removal-pending"
    | "disabled"
    | "failed"
    | "stale";
}

interface TransitCatalogSource {
  id: string;
  name: string;
  source: string;
  countryCode: string;
}

export function sourceStateLabel(source: TransitSource): string {
  if (source.lifecycle === "removal-pending") return "Removal pending · active";
  if (source.lifecycle === "update-pending") return "Update pending · active";
  if (source.lifecycle === "add-pending") return "Add pending · not active";
  if (!source.requested && source.active) return "Not requested · active";
  if (source.requested && !source.active && source.lifecycle === "failed") {
    return "Requested · failed";
  }
  if (source.requested && source.active) return "Requested · active";
  return "Disabled · not active";
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

async function responseJson<T>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${fallback} (HTTP ${response.status})`);
  return body;
}

export function TransitSourcesSection({ apiUrl }: { apiUrl: string }) {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [licenseSpdx, setLicenseSpdx] = useState("");
  const [licenseUrl, setLicenseUrl] = useState("");
  const [attribution, setAttribution] = useState("");
  const [catalogSearch, setCatalogSearch] = useState("");
  const [lastJobId, setLastJobId] = useState<string | null>(null);

  const sourcesQuery = useQuery<{ sources: TransitSource[]; total: number }>({
    queryKey: ["admin", "transit", "sources"],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/sources?limit=500`, {
        credentials: "include",
      }).then((response) => responseJson(response, "Failed to load transit sources")),
    refetchInterval: 30_000,
  });
  const stateQuery = useQuery<{ currentJob: { jobId: string } | null }>({
    queryKey: ["admin", "transit", "state"],
    queryFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/state`, { credentials: "include" }).then(
        (response) => responseJson(response, "Failed to load transit sync state"),
      ),
    refetchInterval: 10_000,
  });
  const catalogQuery = useQuery<{ sources: TransitCatalogSource[] }>({
    queryKey: ["admin", "transit", "catalog", catalogSearch],
    enabled: dialogOpen && catalogSearch.trim().length >= 2,
    queryFn: () => {
      const params = new URLSearchParams({ search: catalogSearch.trim() });
      return fetch(`${apiUrl}/api/data-manager/transit/catalog?${params}`, {
        credentials: "include",
      }).then((response) => responseJson(response, "Failed to search the transit catalog"));
    },
  });

  const reportJob = (jobId: string, message: string) => {
    setLastJobId(jobId);
    setToast(message);
    void queryClient.invalidateQueries({ queryKey: ["admin", "transit"] });
  };
  const addMutation = useMutation({
    mutationFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/sources`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          name: name.trim(),
          region: region.trim(),
          license: {
            attribution: attribution.trim(),
            ...(licenseSpdx.trim() ? { spdxIdentifier: licenseSpdx.trim() } : {}),
            ...(licenseUrl.trim() ? { url: licenseUrl.trim() } : {}),
          },
        }),
      }).then((response) => responseJson<{ jobId: string }>(response, "Failed to add source")),
    onSuccess: ({ jobId }) => {
      reportJob(jobId, `Source change queued as ${jobId}.`);
      setDialogOpen(false);
      setUrl("");
      setName("");
      setRegion("");
      setLicenseSpdx("");
      setLicenseUrl("");
      setAttribution("");
    },
    onError: (error) => setToast((error as Error).message),
  });
  const sourceMutation = useMutation({
    mutationFn: ({ sourceId, method }: { sourceId: string; method: "DELETE" | "POST" }) => {
      const suffix = method === "POST" ? "/enable" : "";
      return fetch(
        `${apiUrl}/api/data-manager/transit/sources/${encodeURIComponent(sourceId)}${suffix}`,
        {
          method,
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        },
      ).then((response) =>
        responseJson<{ jobId: string; sourceId: string }>(response, "Failed to change source"),
      );
    },
    onSuccess: ({ jobId, sourceId }) => reportJob(jobId, `${sourceId} queued as ${jobId}.`),
    onError: (error) => setToast((error as Error).message),
  });
  const syncMutation = useMutation({
    mutationFn: () =>
      fetch(`${apiUrl}/api/data-manager/transit/sync`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).then((response) => responseJson<{ jobId: string }>(response, "Failed to sync sources")),
    onSuccess: ({ jobId }) => reportJob(jobId, `Transit sync queued as ${jobId}.`),
    onError: (error) => setToast((error as Error).message),
  });

  const sources = sourcesQuery.data?.sources ?? [];
  const { query, setQuery, filtered } = useTextFilter(sources, (source) =>
    [source.id, source.name, source.region, source.origin, source.originUrl]
      .filter(Boolean)
      .join(" "),
  );
  const { paged, paginationProps } = useClientPagination(filtered);
  const syncJob = stateQuery.data?.currentJob ?? null;
  const mutationPending =
    addMutation.isPending || sourceMutation.isPending || syncMutation.isPending;
  const actionsDisabled = syncJob !== null || mutationPending;
  const disabledReason = syncJob
    ? `Transit sync ${syncJob.jobId} is active. Open Activity to monitor it.`
    : mutationPending
      ? "A source change is being queued."
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
            Transit sources
          </Typography>
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Button component={Link} href="/admin/activity" variant="outlined" size="small">
            Activity
          </Button>
          <Tooltip title={disabledReason} disableHoverListener={!actionsDisabled}>
            <span>
              <Button
                variant="outlined"
                size="small"
                disabled={actionsDisabled}
                onClick={() => syncMutation.mutate()}
              >
                Sync sources
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={disabledReason} disableHoverListener={!actionsDisabled}>
            <span>
              <Button
                variant="contained"
                size="small"
                disabled={actionsDisabled}
                onClick={() => setDialogOpen(true)}
              >
                Add source
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
            <Button component={Link} href="/admin/activity" size="small" color="inherit">
              View job
            </Button>
          }
        >
          {syncJob
            ? `Transit sync ${syncJob.jobId} is active; source actions are disabled.`
            : `Source change queued as ${lastJobId}.`}
        </Alert>
      )}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add transit source</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Alert severity="info">
              The current MOTIS dataset remains active if acquisition, validation, or promotion
              fails.
            </Alert>
            <TextField
              label="Schedule URL"
              placeholder="https://example.com/feed.gtfs.zip"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              autoFocus
              fullWidth
              size="small"
            />
            <TextField
              label="Safe display name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              label="Region"
              placeholder="de-be"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              fullWidth
              size="small"
            />
            <TextField
              label="Attribution"
              value={attribution}
              onChange={(event) => setAttribution(event.target.value)}
              fullWidth
              size="small"
            />
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
              <TextField
                label="SPDX license"
                placeholder="CC-BY-4.0"
                value={licenseSpdx}
                onChange={(event) => setLicenseSpdx(event.target.value)}
                fullWidth
                size="small"
              />
              <TextField
                label="License URL"
                value={licenseUrl}
                onChange={(event) => setLicenseUrl(event.target.value)}
                fullWidth
                size="small"
              />
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Provide an SPDX identifier or license URL. Credentials are not accepted in source
              URLs; configure secrets separately.
            </Typography>
            <TextField
              label="Search installed catalog (optional)"
              value={catalogSearch}
              onChange={(event) => setCatalogSearch(event.target.value)}
              fullWidth
              size="small"
            />
            {catalogQuery.data?.sources
              .filter((source) => source.source === "transitous")
              .slice(0, 5)
              .map((source) => (
                <Button
                  key={source.id}
                  variant="text"
                  sx={{ justifyContent: "flex-start" }}
                  disabled={actionsDisabled}
                  onClick={() => {
                    sourceMutation.mutate({ sourceId: source.id, method: "POST" });
                    setDialogOpen(false);
                  }}
                >
                  Enable {source.name} ({source.countryCode})
                </Button>
              ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={addMutation.isPending}>
            Cancel
          </Button>
          <Button variant="contained" disabled={!addValid} onClick={() => addMutation.mutate()}>
            {addMutation.isPending ? "Queueing…" : "Add and sync"}
          </Button>
        </DialogActions>
      </Dialog>
      <Box sx={{ mb: 2 }}>
        <TableToolbar>
          <TableSearchField
            value={query}
            onChange={setQuery}
            placeholder="Search sources by name, region, ID, or URL…"
          />
        </TableToolbar>
      </Box>
      <TableContainer sx={{ overflowX: "auto" }}>
        <Table size="small" sx={{ minWidth: 960 }}>
          <TableHead>
            <TableRow>
              <TableCell>Source</TableCell>
              <TableCell>Origin</TableCell>
              <TableCell>State</TableCell>
              <TableCell>Format / size</TableCell>
              <TableCell>Validation</TableCell>
              <TableCell>Last fetched</TableCell>
              <TableCell>Last promoted</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sourcesQuery.isError ? (
              <TableEmptyState colSpan={8} message="Failed to load transit sources." />
            ) : paged.length === 0 ? (
              <TableEmptyState colSpan={8} message="No transit sources match." />
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
                      label={sourceStateLabel(source)}
                      size="small"
                      color={stateColor(source.lifecycle)}
                    />
                  </TableCell>
                  <TableCell>
                    {source.format.toUpperCase()}
                    {source.artifact ? ` · ${formatBytes(source.artifact.sizeBytes)}` : ""}
                  </TableCell>
                  <TableCell>
                    <Tooltip title={source.validationMessage ?? ""}>
                      <span>{source.validationStatus ?? "Not validated"}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell>
                    {source.lastFetchedAt ? formatDate(source.lastFetchedAt) : "—"}
                  </TableCell>
                  <TableCell>
                    {source.lastImportedAt ? formatDate(source.lastImportedAt) : "—"}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title={disabledReason} disableHoverListener={!actionsDisabled}>
                      <span>
                        <Button
                          size="small"
                          disabled={actionsDisabled}
                          onClick={() =>
                            sourceMutation.mutate({
                              sourceId: source.id,
                              method: source.requested ? "DELETE" : "POST",
                            })
                          }
                        >
                          {source.requested ? "Disable" : "Enable"}
                        </Button>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <AdminTablePagination {...paginationProps} />
      <Snackbar
        open={toast !== null}
        autoHideDuration={4000}
        onClose={() => setToast(null)}
        message={toast}
      />
    </Paper>
  );
}
