"use client";

import SearchIcon from "@mui/icons-material/Search";
import StorageIcon from "@mui/icons-material/Storage";
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
import { listAdminServicePresets, unwrapAdminResponse } from "@openmapx/core/api-admin-sdk";
import type { AdminServiceSummary, AdminServicesBulkAction } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  useServiceHealthCheck,
  useServiceSelection,
  useServiceSelectionSave,
  useServicesBulkAction,
  useServicesList,
} from "@/hooks/useServices";
import { serviceActionReason } from "@/lib/admin/serviceAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useActivityClient } from "../activity/activityQueries";
import { StatusBadge } from "../integrations/StatusBadge";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { CompactAlert } from "../shared/CompactAlert";
import { ServiceStatusChip } from "../shared/ServiceStatusChip";
import { TableEmptyState } from "../shared/TableEmptyState";
import { useClientPagination } from "../shared/tableHooks";

type QualityFilter = "all" | AdminServiceSummary["quality"];

type BulkAction = AdminServicesBulkAction["action"];
const emptyServices: AdminServiceSummary[] = [];

function ProvidesCell({ provides }: { provides: string[] }) {
  if (!provides.length) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: "text.disabled",
        }}
      >
        —
      </Typography>
    );
  }
  return (
    <Stack
      direction="row"
      sx={{
        gap: 0.5,
        flexWrap: "wrap",
      }}
    >
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
            <Stack
              sx={{
                gap: 0.5,
              }}
            >
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
  services: AdminServiceSummary[],
  search: string,
  quality: QualityFilter,
  enabled: "all" | "enabled" | "disabled",
  capability: string,
): AdminServiceSummary[] {
  const q = search.trim().toLowerCase();
  return services.filter((s) => {
    if (quality !== "all" && s.quality !== quality) return false;
    if (enabled !== "all" && s.enabled !== (enabled === "enabled")) return false;
    if (capability && !s.provides.includes(capability)) return false;
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
  const { apiUrl } = useActivityClient();
  return <ServiceCatalogView key={apiUrl} />;
}

function ServiceCatalogView() {
  const { client, apiUrl } = useActivityClient();
  const owner = useAdminMutationOwner(client);
  const showToast = useAdminToast();
  const { data, isLoading, isError, refetch } = useServicesList();

  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState<QualityFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [buildRegion, setBuildRegion] = useState("");
  const [buildContinueOnError, setBuildContinueOnError] = useState(true);
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [capability, setCapability] = useState("");
  const [preset, setPreset] = useState("");
  const [noDeps, setNoDeps] = useState(false);
  const [motisImport, setMotisImport] = useState(false);
  const presets = useQuery({
    queryKey: ["admin", "service-presets", apiUrl],
    queryFn: async () => unwrapAdminResponse(await listAdminServicePresets({ client })),
    retry: false,
  });

  const selectionQuery = useServiceSelection();

  const [selectionDraft, setSelectionDraft] = useState("");

  useEffect(() => {
    const roots = selectionQuery.data?.selectedRoots ?? [];
    setSelectionDraft(roots.join(", "));
  }, [selectionQuery.data?.selectedRoots]);

  const services = data?.services ?? emptyServices;
  const summary = data?.summary;
  const filtered = useMemo(
    () => filterServices(services, search, quality, enabledFilter, capability),
    [services, search, quality, enabledFilter, capability],
  );
  const { paged, paginationProps } = useClientPagination(filtered);

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

  const allVisibleSelected = paged.length > 0 && paged.every((svc) => selectedIds.has(svc.id));

  const toggleSelected = (id: string) => {
    setPreset("");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectVisible = () => {
    setPreset("");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const svc of paged) next.delete(svc.id);
      } else {
        for (const svc of paged) next.add(svc.id);
      }
      return next;
    });
  };

  const deniedIds = (action: BulkAction) =>
    [...selectedIds].filter((id) => {
      const decision = services.find((service) => service.id === id)?.actions?.[action];
      return Boolean(serviceActionReason(decision)) || decision?.workflow === "core-restart";
    });
  const bulkReason = (action: BulkAction) => {
    const denied = deniedIds(action);
    return denied.length
      ? `Unavailable for: ${denied.join(", ")}. Use individual core Restart where available.`
      : undefined;
  };
  const healthCheckMutation = useServiceHealthCheck();
  const saveSelectionMutation = useServiceSelectionSave();
  const bulkMutation = useServicesBulkAction();

  async function checkHealth() {
    const execution = owner;
    try {
      const result = await healthCheckMutation.mutateAsync();
      if (execution.active) showToast(`Checked ${result.statuses.length} service(s)`);
    } catch (error) {
      if (execution.active)
        showToast(error instanceof Error ? error.message : "Check failed", "error");
    }
  }
  async function persistRoots(roots: string[]) {
    const execution = owner;
    try {
      const result = await saveSelectionMutation.mutateAsync(roots);
      if (execution.active)
        showToast(
          "jobId" in result
            ? `Queued service selection (${result.jobId})`
            : "Service selection saved",
        );
    } catch (error) {
      if (execution.active)
        showToast(error instanceof Error ? error.message : "Save failed", "error");
    }
  }
  const saveSelection = () => persistRoots(parseRootInput(selectionDraft));
  const selectPreset = (id: string) => {
    setPreset(id);
    const choice = presets.data?.presets.find((preset) => preset.id === id);
    if (!choice) return;
    if (choice.missingIds.length) {
      setPreset("");
      showToast(`Preset is missing: ${choice.missingIds.join(", ")}`, "warning");
      return;
    }
    setSelectedIds(new Set(choice.rootIds));
  };
  async function queueBulk(payload: AdminServicesBulkAction) {
    const execution = owner;
    try {
      const result = await bulkMutation.mutateAsync(payload);
      if (execution.active) showToast(`Queued ${payload.action} (${result.jobId})`);
    } catch (error) {
      if (execution.active)
        showToast(error instanceof Error ? error.message : "Bulk action failed", "error");
    }
  }

  const queueBulkAction = (action: BulkAction) => {
    const ids = [...selectedIds];
    if (deniedIds(action).length) {
      showToast(bulkReason(action) ?? "Action unavailable", "warning");
      return;
    }
    if (action !== "build" && ids.length === 0) {
      showToast("Select one or more services first", "warning");
      return;
    }

    if (action === "build") {
      if (motisImport && !ids.includes("motis")) {
        showToast("MOTIS import requires selecting MOTIS", "warning");
        return;
      }
      void queueBulk({
        action,
        serviceIds: ids,
        region: buildRegion.trim() || undefined,
        continueOnError: buildContinueOnError,
        ...(motisImport ? { motisImport: true } : {}),
      });
      return;
    }

    void queueBulk(
      action === "update" ? { action, serviceIds: ids, noDeps } : { action, serviceIds: ids },
    );
  };

  const queueBuildAll = () => {
    void queueBulk({
      action: "build",
      all: true,
      region: buildRegion.trim() || undefined,
      continueOnError: buildContinueOnError,
      ...(motisImport ? { motisImport: true } : {}),
    });
  };

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {data?.acquisition.state === "unavailable" && (
        <CompactAlert severity="warning">
          Operations agent is unavailable. Service state is unknown.{" "}
          <Button onClick={() => void refetch()} size="small">
            Retry
          </Button>
        </CompactAlert>
      )}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1">Action presets</Typography>
        <Typography variant="body2">
          Choose root services for the action checkboxes. This does not save service selection;
          dependency expansion and action availability still apply.
        </Typography>
        <TextField
          select
          label="Preset (actions only)"
          value={preset}
          onChange={(e) => selectPreset(e.target.value)}
          size="small"
          sx={{ mt: 1, minWidth: 240 }}
        >
          <MenuItem value="">Custom selection</MenuItem>
          {(presets.data?.presets ?? []).map((item) => (
            <MenuItem key={item.id} value={item.id}>
              {item.id} ({item.rootIds.join(", ")})
              {item.missingIds.length ? " — missing services" : ""}
            </MenuItem>
          ))}
        </TextField>
        {presets.isError && (
          <CompactAlert severity="warning">
            Presets are unavailable; service selection remains unchanged.
          </CompactAlert>
        )}
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack
          sx={{
            gap: 1.5,
          }}
        >
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 700,
            }}
          >
            Service Selection
          </Typography>
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
            }}
          >
            Manage persisted service roots from <code>service-selection.json</code>. Effective
            services include dependencies of selected roots. Removing a root can keep it enabled as
            another root’s dependency.
          </Typography>

          {selectionQuery.data?.source === "env" && selectionQuery.data.envVarValue && (
            <CompactAlert severity="warning" variant="outlined">
              Selection is currently controlled by environment variable{" "}
              <code>{selectionQuery.data.envVarName}</code>. File edits are disabled until the env
              override is removed.
            </CompactAlert>
          )}

          {selectionQuery.isLoading ? (
            <CircularProgress size={20} />
          ) : selectionQuery.isError ? (
            <CompactAlert severity="error" variant="outlined">
              Failed to load service selection
            </CompactAlert>
          ) : (
            <Stack
              sx={{
                gap: 1.25,
              }}
            >
              <TextField
                label="Selected root service IDs"
                size="small"
                value={selectionDraft}
                onChange={(e) => setSelectionDraft(e.target.value)}
                placeholder="app-api, valhalla, osrm"
                disabled={selectionQuery.data?.source === "env" || saveSelectionMutation.isPending}
              />
              <Stack
                direction="row"
                sx={{
                  gap: 0.75,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
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
                  onClick={() => void saveSelection()}
                  disabled={
                    saveSelectionMutation.isPending || selectionQuery.data?.source === "env"
                  }
                >
                  Save Selection
                </Button>
              </Stack>

              {!!selectionQuery.data?.warnings.length && (
                <CompactAlert severity="warning" variant="outlined">
                  {selectionQuery.data.warnings.map((warning) => (
                    <Typography key={warning} variant="body2">
                      {warning}
                    </Typography>
                  ))}
                </CompactAlert>
              )}

              {!!selectionQuery.data?.missingIds.length && (
                <CompactAlert severity="error" variant="outlined">
                  Missing service IDs: {selectionQuery.data.missingIds.join(", ")}
                </CompactAlert>
              )}
            </Stack>
          )}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack
          sx={{
            gap: 1.25,
          }}
        >
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1,
              flexWrap: "wrap",
            }}
          >
            <Typography
              variant="subtitle1"
              sx={{
                fontWeight: 700,
              }}
            >
              Bulk Actions
            </Typography>
            <Chip label={`${selectedIds.size} selected`} size="small" variant="outlined" />
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              variant="outlined"
              onClick={() => void checkHealth()}
              disabled={healthCheckMutation.isPending || bulkMutation.isPending}
            >
              {healthCheckMutation.isPending ? "Checking..." : "Run Service Check"}
            </Button>
          </Stack>

          <Stack
            direction={{ xs: "column", sm: "row" }}
            sx={{
              gap: 1,
              alignItems: { sm: "center" },
            }}
          >
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

          <Stack
            direction="row"
            sx={{
              gap: 0.75,
              flexWrap: "wrap",
            }}
          >
            <FormControlLabel
              control={
                <Checkbox
                  checked={noDeps}
                  onChange={(e) => setNoDeps(e.target.checked)}
                  disabled={bulkMutation.isPending}
                />
              }
              label="Update without dependency recreation"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={motisImport}
                  onChange={(e) => setMotisImport(e.target.checked)}
                  disabled={bulkMutation.isPending}
                />
              }
              label="Import MOTIS after build"
            />
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("start")}
              title={bulkReason("start")}
              disabled={
                bulkMutation.isPending || selectedIds.size === 0 || deniedIds("start").length > 0
              }
            >
              Start Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => queueBulkAction("stop")}
              title={bulkReason("stop")}
              disabled={
                bulkMutation.isPending || selectedIds.size === 0 || deniedIds("stop").length > 0
              }
            >
              Stop Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("restart")}
              title={bulkReason("restart")}
              disabled={
                bulkMutation.isPending || selectedIds.size === 0 || deniedIds("restart").length > 0
              }
            >
              Restart Selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("update")}
              title={bulkReason("update")}
              disabled={
                bulkMutation.isPending || selectedIds.size === 0 || deniedIds("update").length > 0
              }
            >
              Update selected
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => queueBulkAction("build")}
              title={
                motisImport && !selectedIds.has("motis")
                  ? "MOTIS import requires selecting MOTIS"
                  : bulkReason("build")
              }
              disabled={
                bulkMutation.isPending ||
                selectedIds.size === 0 ||
                deniedIds("build").length > 0 ||
                (motisImport && !selectedIds.has("motis"))
              }
            >
              Build Selected
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={queueBuildAll}
              disabled={
                bulkMutation.isPending ||
                !services.some((s) => s.actions?.build.available) ||
                (motisImport &&
                  !services.some((s) => s.id === "motis" && s.enabled && s.actions.build.available))
              }
            >
              Build All
            </Button>
            <Button component={Link} href="/admin/activity" size="small" variant="text">
              View Jobs
            </Button>
          </Stack>
          {selectedIds.size > 0 &&
            ["start", "stop", "restart", "update", "build"].some(
              (action) => deniedIds(action as BulkAction).length > 0,
            ) && (
              <Typography role="status" variant="caption" color="text.secondary">
                Unavailable targets:{" "}
                {["start", "stop", "restart", "update", "build"]
                  .map((action) => {
                    const ids = deniedIds(action as BulkAction);
                    return ids.length ? `${action}: ${ids.join(", ")}` : null;
                  })
                  .filter(Boolean)
                  .join("; ")}
                . Check individual service controls for the available workflow.
              </Typography>
            )}
        </Stack>
      </Paper>
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 1,
        }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            flexWrap: "wrap",
            minWidth: 0,
            gap: 1,
          }}
        >
          <StorageIcon sx={{ color: "text.secondary" }} />
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
            }}
          >
            Service Catalog
          </Typography>
          {!isLoading && summary && (
            <Stack
              direction="row"
              sx={{
                gap: 0.5,
                flexWrap: "wrap",
              }}
            >
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
      {!!data?.capabilityInventory?.unrecognized.length && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <details>
            <summary>
              Unrecognized capability vocabulary ({data.capabilityInventory.unrecognized.length})
            </summary>
            <Typography variant="body2">
              Custom vendor names are allowed. Check non-namespaced entries for spelling errors.
            </Typography>
            {data.capabilityInventory.unrecognized.map((item) => (
              <Typography variant="body2" key={item.capability}>
                {item.capability}: {item.serviceIds.join(", ")}
              </Typography>
            ))}
          </details>
        </Paper>
      )}
      <AdminTableSurface
        toolbar={
          <Stack
            direction="row"
            sx={{
              gap: 1,
              flexWrap: "wrap",
            }}
          >
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
            <TextField
              select
              size="small"
              label="Enabled state"
              value={enabledFilter}
              onChange={(e) => setEnabledFilter(e.target.value as typeof enabledFilter)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="all">All services</MenuItem>
              <MenuItem value="enabled">Enabled</MenuItem>
              <MenuItem value="disabled">Disabled</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="Exact capability"
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="">All capabilities</MenuItem>
              {[
                ...new Set([
                  ...(data?.capabilityInventory?.recognized ?? []),
                  ...(data?.capabilityInventory?.unrecognized ?? []).map((item) => item.capability),
                ]),
              ]
                .sort()
                .map((item) => (
                  <MenuItem key={item} value={item}>
                    {item}
                  </MenuItem>
                ))}
            </TextField>
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
        }
        pagination={<AdminTablePagination {...paginationProps} />}
      >
        {summary && summary.unknown > 0 && (
          <CompactAlert severity="warning">
            {summary.unknown} service(s) have unknown status.
          </CompactAlert>
        )}
        {isError && (
          <CompactAlert
            severity="error"
            variant="outlined"
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
          </CompactAlert>
        )}
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    slotProps={{ input: { "aria-label": "Select visible services" } }}
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
                <TableEmptyState
                  colSpan={6}
                  message={
                    services.length === 0
                      ? "No services registered yet."
                      : "No services match the current filters."
                  }
                />
              ) : (
                paged.map((svc) => (
                  <TableRow key={svc.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        slotProps={{ input: { "aria-label": `Select ${svc.id}` } }}
                        checked={selectedIds.has(svc.id)}
                        onChange={() => toggleSelected(svc.id)}
                      />
                    </TableCell>
                    <TableCell>
                      <Stack
                        sx={{
                          gap: 0.25,
                        }}
                      >
                        <Typography
                          component={Link}
                          href={`/admin/services/${svc.id}`}
                          variant="body2"
                          sx={{
                            fontWeight: 600,
                            textDecoration: "none",
                            color: "primary.main",
                          }}
                        >
                          {svc.name}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            fontFamily: "monospace",
                          }}
                        >
                          {svc.id}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        sx={{
                          fontFamily: "monospace",
                        }}
                      >
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
                      <ServiceStatusChip status={svc.status} />
                      <Typography variant="caption" sx={{ display: "block" }}>
                        {svc.enabled ? "Enabled" : "Disabled"}
                        {selectionQuery.data?.selectedRoots.includes(svc.id)
                          ? " · root"
                          : svc.enabled
                            ? " · dependency"
                            : ""}
                      </Typography>
                      <Button
                        size="small"
                        disabled={
                          !selectionQuery.data ||
                          selectionQuery.isError ||
                          selectionQuery.data.source === "env" ||
                          saveSelectionMutation.isPending ||
                          (svc.enabled && !selectionQuery.data.selectedRoots.includes(svc.id))
                        }
                        title={
                          svc.enabled && !selectionQuery.data?.selectedRoots.includes(svc.id)
                            ? "Required by a selected root. Edit the roots to remove that dependency."
                            : undefined
                        }
                        onClick={() =>
                          void persistRoots(
                            selectionQuery.data?.selectedRoots.includes(svc.id)
                              ? selectionQuery.data.selectedRoots.filter((id) => id !== svc.id)
                              : [...(selectionQuery.data?.selectedRoots ?? []), svc.id],
                          )
                        }
                      >
                        {selectionQuery.data?.selectedRoots.includes(svc.id)
                          ? `Remove ${svc.id} root`
                          : svc.enabled
                            ? "Required dependency"
                            : `Enable ${svc.id}`}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </AdminTableSurface>
      {!isLoading && !isError && filtered.length > 0 && (
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          Showing {filtered.length} of {services.length} services
        </Typography>
      )}
    </Stack>
  );
}
