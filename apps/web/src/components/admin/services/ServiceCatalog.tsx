"use client";

import SearchIcon from "@mui/icons-material/Search";
import StorageIcon from "@mui/icons-material/Storage";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
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
import { useEffect, useMemo, useState } from "react";
import type { ServiceQuality, ServiceStatus, ServiceSummary } from "@/hooks/useServices";
import { useServicesList } from "@/hooks/useServices";
import { useEnv } from "@/lib/EnvProvider";
import { StatusBadge } from "../integrations/StatusBadge";
import { useAdminToast } from "../shared/AdminToast";

type QualityFilter = "all" | ServiceQuality;

type BulkAction = "start" | "stop" | "restart" | "recreate" | "build";

interface ServiceSelectionSummary {
  source: "env" | "file" | "default";
  selectedRoots: string[];
  requestedIds: string[];
  effectiveIds: string[];
  warnings: string[];
  missingIds: string[];
  envVarName: string;
  envVarValue: string | null;
  selectionFilePath: string;
}

function statusColor(status: ServiceStatus): "success" | "warning" | "error" | "default" {
  if (status === "running") return "success";
  if (status === "restarting") return "warning";
  if (status === "exited") return "error";
  return "default";
}

function statusLabel(status: ServiceStatus): string {
  if (status === "not-running") return "Not running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StatusChip({ status }: { status: ServiceStatus }) {
  return (
    <Chip
      label={statusLabel(status)}
      size="small"
      color={statusColor(status)}
      variant={status === "running" ? "filled" : "outlined"}
      sx={{ fontSize: "0.7rem" }}
    />
  );
}

function ProvidesCell({ provides }: { provides: string[] }) {
  if (!provides.length) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  return (
    <Stack direction="row" gap={0.5} flexWrap="wrap">
      {provides.slice(0, 3).map((p) => (
        <Chip
          key={p}
          label={p}
          size="small"
          variant="outlined"
          sx={{ fontSize: "0.65rem", fontFamily: "monospace" }}
        />
      ))}
      {provides.length > 3 && (
        <Tooltip title={provides.slice(3).join(", ")}>
          <Chip
            label={`+${provides.length - 3}`}
            size="small"
            variant="outlined"
            sx={{ fontSize: "0.65rem" }}
          />
        </Tooltip>
      )}
    </Stack>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f"] as const;

function SkeletonRows() {
  return (
    <>
      {SKELETON_KEYS.map((k) => (
        <TableRow key={k}>
          <TableCell>
            <Skeleton width={24} height={18} />
          </TableCell>
          <TableCell>
            <Stack gap={0.5}>
              <Skeleton width={120} height={18} />
              <Skeleton width={80} height={14} />
            </Stack>
          </TableCell>
          <TableCell>
            <Skeleton width={60} height={18} />
          </TableCell>
          <TableCell>
            <Skeleton width={80} height={24} />
          </TableCell>
          <TableCell>
            <Skeleton width={100} height={24} />
          </TableCell>
          <TableCell>
            <Skeleton width={80} height={24} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}

function filterServices(
  services: ServiceSummary[],
  search: string,
  quality: QualityFilter,
): ServiceSummary[] {
  const q = search.trim().toLowerCase();
  return services.filter((s) => {
    if (quality !== "all" && s.quality !== quality) return false;
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.description?.toLowerCase().includes(q) ?? false) ||
      s.provides.some((p) => p.toLowerCase().includes(q))
    );
  });
}

function parseRootInput(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function ServiceCatalog() {
  const { apiUrl } = useEnv();
  const showToast = useAdminToast();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useServicesList();

  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState<QualityFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [buildRegion, setBuildRegion] = useState("");
  const [buildContinueOnError, setBuildContinueOnError] = useState(true);

  const selectionQuery = useQuery<ServiceSelectionSummary>({
    queryKey: ["admin", "services", "selection"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/selection`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load service selection");
      return res.json();
    },
  });

  const [selectionDraft, setSelectionDraft] = useState("");

  useEffect(() => {
    const roots = selectionQuery.data?.selectedRoots ?? [];
    setSelectionDraft(roots.join(", "));
  }, [selectionQuery.data?.selectedRoots]);

  const services = data?.services ?? [];
  const summary = data?.summary;
  const filtered = useMemo(
    () => filterServices(services, search, quality),
    [services, search, quality],
  );

  useEffect(() => {
    setSelectedIds((prev) => {
      const validIds = new Set(services.map((service) => service.id));
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) next.add(id);
      }
      return next;
    });
  }, [services]);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((svc) => selectedIds.has(svc.id));

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const svc of filtered) next.delete(svc.id);
      } else {
        for (const svc of filtered) next.add(svc.id);
      }
      return next;
    });
  };

  const healthCheckMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/services/check`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to run service health check");
      return res.json() as Promise<{ statuses: Array<{ service: string }>; checkedAt: string }>;
    },
    onSuccess: (result) => {
      showToast(`Checked ${result.statuses.length} service(s)`);
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Check failed", "error"),
  });

  const saveSelectionMutation = useMutation({
    mutationFn: async (selectedRoots: string[]) => {
      const res = await fetch(`${apiUrl}/api/admin/services/selection`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedRoots }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to save selection");
      }
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      showToast("Service selection saved");
      queryClient.invalidateQueries({ queryKey: ["admin", "services", "selection"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Save failed", "error"),
  });

  const bulkMutation = useMutation({
    mutationFn: async (payload: {
      action: BulkAction;
      serviceIds?: string[];
      all?: boolean;
      region?: string;
      continueOnError?: boolean;
    }) => {
      const res = await fetch(`${apiUrl}/api/admin/services/bulk-action`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Failed to queue bulk action");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: (result, payload) => {
      showToast(`Queued ${payload.action} (${result.jobId})`);
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Bulk action failed", "error"),
  });

  const queueBulkAction = (action: BulkAction) => {
    const ids = [...selectedIds];
    if (action !== "build" && ids.length === 0) {
      showToast("Select one or more services first", "warning");
      return;
    }

    if (action === "build") {
      bulkMutation.mutate({
        action,
        serviceIds: ids,
        region: buildRegion.trim() || undefined,
        continueOnError: buildContinueOnError,
      });
      return;
    }

    bulkMutation.mutate({ action, serviceIds: ids });
  };

  const queueBuildAll = () => {
    bulkMutation.mutate({
      action: "build",
      all: true,
      region: buildRegion.trim() || undefined,
      continueOnError: buildContinueOnError,
    });
  };

  return (
    <Stack gap={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack gap={1.5}>
          <Typography variant="subtitle1" fontWeight={700}>
            Service Selection
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Manage persisted service roots from <code>service-selection.json</code>. Effective
            services include dependencies of selected roots.
          </Typography>

          {selectionQuery.data?.source === "env" && selectionQuery.data.envVarValue && (
            <Alert severity="warning">
              Selection is currently controlled by environment variable{" "}
              <code>{selectionQuery.data.envVarName}</code>. File edits are disabled until the env
              override is removed.
            </Alert>
          )}

          {selectionQuery.isLoading ? (
            <CircularProgress size={20} />
          ) : selectionQuery.isError ? (
            <Alert severity="error">Failed to load service selection</Alert>
          ) : (
            <Stack gap={1.25}>
              <TextField
                label="Selected root service IDs"
                size="small"
                value={selectionDraft}
                onChange={(e) => setSelectionDraft(e.target.value)}
                placeholder="app-api, valhalla, osrm"
                disabled={selectionQuery.data?.source === "env" || saveSelectionMutation.isPending}
              />
              <Stack direction="row" gap={0.75} flexWrap="wrap" alignItems="center">
                <Chip
                  label={`Requested: ${selectionQuery.data?.requestedIds.length ?? 0}`}
                  size="small"
                  variant="outlined"
                />
                <Chip
                  label={`Effective: ${selectionQuery.data?.effectiveIds.length ?? 0}`}
                  size="small"
                  color="success"
                  variant="outlined"
                />
                <Chip
                  label={`Source: ${selectionQuery.data?.source ?? "unknown"}`}
                  size="small"
                  variant="outlined"
                />
                <Box sx={{ flex: 1 }} />
                <Button
                  size="small"
                  variant="contained"
                  onClick={() => saveSelectionMutation.mutate(parseRootInput(selectionDraft))}
                  disabled={
                    saveSelectionMutation.isPending || selectionQuery.data?.source === "env"
                  }
                >
                  Save Selection
                </Button>
              </Stack>

              {!!selectionQuery.data?.warnings.length && (
                <Alert severity="warning">
                  {selectionQuery.data.warnings.map((warning) => (
                    <Typography key={warning} variant="body2">
                      {warning}
                    </Typography>
                  ))}
                </Alert>
              )}

              {!!selectionQuery.data?.missingIds.length && (
                <Alert severity="error">
                  Missing service IDs: {selectionQuery.data.missingIds.join(", ")}
                </Alert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack gap={1.25}>
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Typography variant="subtitle1" fontWeight={700}>
              Bulk Actions
            </Typography>
            <Chip label={`${selectedIds.size} selected`} size="small" variant="outlined" />
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              variant="outlined"
              onClick={() => healthCheckMutation.mutate()}
              disabled={healthCheckMutation.isPending || bulkMutation.isPending}
            >
              {healthCheckMutation.isPending ? "Checking..." : "Run Service Check"}
            </Button>
          </Stack>

          <Stack direction={{ xs: "column", sm: "row" }} gap={1} alignItems={{ sm: "center" }}>
            <TextField
              size="small"
              label="Build region"
              placeholder="optional"
              value={buildRegion}
              onChange={(e) => setBuildRegion(e.target.value)}
              sx={{ minWidth: { xs: "100%", sm: 220 } }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={buildContinueOnError}
                  onChange={(e) => setBuildContinueOnError(e.target.checked)}
                  size="small"
                />
              }
              label="Continue on build errors"
            />
          </Stack>

          <Stack direction="row" gap={0.75} flexWrap="wrap">
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("start")}
              disabled={bulkMutation.isPending || selectedIds.size === 0}
            >
              Start Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => queueBulkAction("stop")}
              disabled={bulkMutation.isPending || selectedIds.size === 0}
            >
              Stop Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("restart")}
              disabled={bulkMutation.isPending || selectedIds.size === 0}
            >
              Restart Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("recreate")}
              disabled={bulkMutation.isPending || selectedIds.size === 0}
            >
              Recreate Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("build")}
              disabled={bulkMutation.isPending || selectedIds.size === 0}
            >
              Build Selected
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={queueBuildAll}
              disabled={bulkMutation.isPending}
            >
              Build All
            </Button>
            <Button component={Link} href="/admin/activity" size="small" variant="text">
              View Jobs
            </Button>
          </Stack>
        </Stack>
      </Paper>

      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Stack direction="row" alignItems="center" gap={1}>
          <StorageIcon sx={{ color: "text.secondary" }} />
          <Typography variant="h6" fontWeight={700}>
            Service Catalog
          </Typography>
          {!isLoading && summary && (
            <Stack direction="row" gap={0.5}>
              <Chip
                label={`${summary.total} total`}
                size="small"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
              <Chip
                label={`${summary.running} running`}
                size="small"
                color="success"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
              <Chip
                label={`${summary.stopped} stopped`}
                size="small"
                color="default"
                variant="outlined"
                sx={{ fontSize: "0.7rem" }}
              />
            </Stack>
          )}
        </Stack>
        {isLoading && <CircularProgress size={20} />}
      </Stack>

      <Stack direction="row" gap={1.5} flexWrap="wrap">
        <TextField
          size="small"
          placeholder="Search by name, ID, or capability…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
          sx={{ minWidth: 280 }}
        />
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <Select
            value={quality}
            onChange={(e) => setQuality(e.target.value as QualityFilter)}
            displayEmpty
          >
            <MenuItem value="all">All quality tiers</MenuItem>
            <MenuItem value="built-in">Built-in</MenuItem>
            <MenuItem value="community-verified">Community (verified)</MenuItem>
            <MenuItem value="community">Community</MenuItem>
          </Select>
        </FormControl>
      </Stack>

      {isError && (
        <Alert
          severity="error"
          action={
            <Typography
              variant="body2"
              sx={{ cursor: "pointer", textDecoration: "underline" }}
              onClick={() => refetch()}
            >
              Retry
            </Typography>
          }
        >
          Failed to load services. The backend may not be running yet.
        </Alert>
      )}

      <Paper variant="outlined">
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={allVisibleSelected}
                    indeterminate={selectedIds.size > 0 && !allVisibleSelected}
                    onChange={toggleSelectVisible}
                  />
                </TableCell>
                <TableCell>Service</TableCell>
                <TableCell>Version</TableCell>
                <TableCell>Quality</TableCell>
                <TableCell>Provides</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {isLoading ? (
                <SkeletonRows />
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Box py={3} textAlign="center">
                      <Typography variant="body2" color="text.secondary">
                        {services.length === 0
                          ? "No services registered yet."
                          : "No services match the current filters."}
                      </Typography>
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((svc) => (
                  <TableRow key={svc.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        checked={selectedIds.has(svc.id)}
                        onChange={() => toggleSelected(svc.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack gap={0.25}>
                        <Typography
                          component={Link}
                          href={`/admin/services/${svc.id}`}
                          variant="body2"
                          fontWeight={600}
                          sx={{ textDecoration: "none", color: "primary.main" }}
                        >
                          {svc.name}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                          {svc.id}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontFamily="monospace">
                        {svc.version}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <StatusBadge quality={svc.quality} />
                    </TableCell>
                    <TableCell>
                      <ProvidesCell provides={svc.provides} />
                    </TableCell>
                    <TableCell>
                      <StatusChip status={svc.status} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {!isLoading && !isError && filtered.length > 0 && (
        <Typography variant="caption" color="text.secondary">
          Showing {filtered.length} of {services.length} services
        </Typography>
      )}
    </Stack>
  );
}
