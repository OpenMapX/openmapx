"use client";

import SearchIcon from "@mui/icons-material/Search";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import FormControl from "@mui/material/FormControl";
import InputAdornment from "@mui/material/InputAdornment";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import Skeleton from "@mui/material/Skeleton";
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
import { listAdminServicePresets, unwrapAdminResponse } from "@openmapx/core/api-admin-sdk";
import type { AdminServiceSummary, AdminServicesBulkAction } from "@openmapx/core/api-contracts";
import { compareServiceBuildOrder } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  useServiceHealthCheck,
  useServiceImageStage,
  useServicesBulkAction,
  useServicesList,
} from "@/hooks/useServices";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useActivityClient } from "../activity/activityQueries";
import { StatusBadge } from "../integrations/StatusBadge";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { CompactAlert } from "../shared/CompactAlert";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { ServiceStatusChip } from "../shared/ServiceStatusChip";
import { TableEmptyState } from "../shared/TableEmptyState";
import { useClientPagination } from "../shared/tableHooks";
import { ServiceBuildAllDialog, ServiceBulkActions } from "./ServiceBulkActions";

type QualityFilter = "all" | AdminServiceSummary["quality"];

const emptyServices: AdminServiceSummary[] = [];

function ProvidesCell({ provides }: { provides: string[] }) {
  const t = useTranslations("adminServices");
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
            label={t("moreCount", { count: provides.length - 3 })}
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

export function ServiceCatalog() {
  const { apiUrl } = useActivityClient();
  return <ServiceCatalogView key={apiUrl} />;
}

function ServiceCatalogView() {
  const t = useTranslations("adminServices");
  const tCommon = useTranslations("common");
  const { client, apiUrl } = useActivityClient();
  const owner = useAdminMutationOwner(client);
  const showToast = useAdminToast();
  const [lastAcceptedJobId, setLastAcceptedJobId] = useState<string | null>(null);
  const { data, isLoading, isError, refetch } = useServicesList();

  const [search, setSearch] = useState("");
  const [quality, setQuality] = useState<QualityFilter>("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [capability, setCapability] = useState("");
  const [preset, setPreset] = useState("");
  const [buildAllTargets, setBuildAllTargets] = useState<string[] | null>(null);
  const [stageIntent, setStageIntent] = useState<{
    serviceIds: string[];
    idempotencyKey: string;
  } | null>(null);
  const presets = useQuery({
    queryKey: ["admin", "service-presets", apiUrl],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(await listAdminServicePresets({ client, signal })),
    retry: false,
  });

  const services = data?.services ?? emptyServices;
  const summary = data?.summary;
  const filtered = useMemo(
    () => filterServices(services, search, quality, enabledFilter, capability),
    [services, search, quality, enabledFilter, capability],
  );
  const { paged, paginationProps } = useClientPagination(filtered);

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

  const healthCheckMutation = useServiceHealthCheck();
  const bulkMutation = useServicesBulkAction();
  const stageMutation = useServiceImageStage();
  async function stageImages() {
    if (!stageIntent) return;
    const execution = owner;
    try {
      const result = await stageMutation.mutateAsync(stageIntent);
      if (execution.active) setLastAcceptedJobId(result.jobId);
      if (execution.active) {
        setStageIntent(null);
        showToast(t("imageStagingQueued", { jobId: result.jobId }));
      }
    } catch (error) {
      if (execution.active) showToast(adminErrorText(error, t("imageStagingFailed")), "error");
    }
  }

  async function checkHealth() {
    const execution = owner;
    try {
      const result = await healthCheckMutation.mutateAsync();
      if (execution.active) showToast(t("checkedServices", { count: result.statuses.length }));
    } catch (error) {
      if (execution.active) showToast(adminErrorText(error, t("checkFailed")), "error");
    }
  }
  const selectPreset = (id: string) => {
    setPreset(id);
    const choice = presets.data?.presets.find((preset) => preset.id === id);
    if (!choice) return;
    if (choice.missingIds.length) {
      setPreset("");
      showToast(t("presetMissing", { missingIds: choice.missingIds.join(", ") }), "warning");
      return;
    }
    setSelectedIds(new Set(choice.rootIds));
  };
  async function queueBulk(payload: AdminServicesBulkAction) {
    const execution = owner;
    try {
      const result = await bulkMutation.mutateAsync(payload);
      if (execution.active) setLastAcceptedJobId(result.jobId);
      if (execution.active)
        showToast(t("bulkActionQueued", { action: payload.action, jobId: result.jobId }));
      return execution.active;
    } catch (error) {
      if (execution.active) showToast(adminErrorText(error, t("bulkActionFailed")), "error");
      return false;
    }
  }

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <ConfirmDialog
        open={stageIntent !== null}
        title={t("stageSelectedImages")}
        message={t("downloadImagesConfirm", {
          services: stageIntent?.serviceIds.join(", ") ?? "",
        })}
        confirmLabel={t("stageImages")}
        loading={stageMutation.isPending}
        onConfirm={() => void stageImages()}
        onCancel={() => setStageIntent(null)}
      />
      <AdminPageHeader
        title={t("services")}
        subtitle={t("serviceCounts", {
          total: summary?.total ?? "—",
          running: summary?.running ?? "—",
          stopped: summary?.stopped ?? "—",
        })}
        actions={
          <>
            <Button
              size="small"
              variant="outlined"
              onClick={() => void checkHealth()}
              disabled={healthCheckMutation.isPending || bulkMutation.isPending}
            >
              {healthCheckMutation.isPending ? t("checking") : t("runServiceCheck")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() =>
                setBuildAllTargets(
                  services
                    .filter((service) => service.enabled && service.actions?.build.available)
                    .map((service) => service.id)
                    .sort(compareServiceBuildOrder),
                )
              }
              disabled={
                bulkMutation.isPending ||
                !services.some((service) => service.enabled && service.actions?.build.available)
              }
            >
              {t("buildAll")}
            </Button>
            <Button size="small" component={Link} href="/admin/system/deployment">
              {t("deployment")}
            </Button>
            {lastAcceptedJobId && (
              <Button
                size="small"
                component={Link}
                href={adminJobHref({ id: lastAcceptedJobId, source: "application" })}
              >
                {t("viewJobs")}
              </Button>
            )}
          </>
        }
      />
      {buildAllTargets && (
        <ServiceBuildAllDialog
          ids={buildAllTargets}
          busy={bulkMutation.isPending}
          onQueue={queueBulk}
          onClose={() => setBuildAllTargets(null)}
        />
      )}
      {data?.acquisition.state === "unavailable" && (
        <CompactAlert severity="warning">
          {t("operationsAgentIsUnavailableService")}
          <Button onClick={() => void refetch()} size="small">
            {tCommon("retry")}
          </Button>
        </CompactAlert>
      )}
      {selectedIds.size > 0 && (
        <ServiceBulkActions
          services={services}
          selectedIds={selectedIds}
          busy={bulkMutation.isPending || stageMutation.isPending}
          onQueue={(payload) => void queueBulk(payload)}
          onStage={(ids) =>
            setStageIntent({ serviceIds: [...ids], idempotencyKey: crypto.randomUUID() })
          }
          onClear={() => {
            setSelectedIds(new Set());
            setPreset("");
          }}
        />
      )}
      {presets.isError && (
        <CompactAlert severity="warning">{t("presetsAreUnavailableChooseAction")}</CompactAlert>
      )}
      {!!data?.capabilityInventory?.unrecognized.length && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <details>
            <summary>
              {t("unrecognizedVocabulary", {
                count: data.capabilityInventory.unrecognized.length,
              })}
            </summary>
            <Typography variant="body2">{t("customVendorNamesAreAllowed")}</Typography>
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
              select
              label={t("presetActionsOnly")}
              value={preset}
              onChange={(event) => selectPreset(event.target.value)}
              size="small"
              sx={{ minWidth: 240 }}
            >
              <MenuItem value="">{t("customSelection")}</MenuItem>
              {(presets.data?.presets ?? []).map((item) => (
                <MenuItem key={item.id} value={item.id}>
                  {t(item.missingIds.length ? "presetOptionMissing" : "presetOption", {
                    id: item.id,
                    roots: item.rootIds.join(", "),
                  })}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              placeholder={t("searchByNameIdOr")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              slotProps={{
                htmlInput: { "aria-label": t("searchServices") },
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
              label={t("enabledState")}
              value={enabledFilter}
              onChange={(e) => setEnabledFilter(e.target.value as typeof enabledFilter)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="all">{t("allServices")}</MenuItem>
              <MenuItem value="enabled">{t("enabled")}</MenuItem>
              <MenuItem value="disabled">{t("disabled")}</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label={t("exactCapability")}
              value={capability}
              onChange={(e) => setCapability(e.target.value)}
              sx={{ minWidth: 200 }}
            >
              <MenuItem value="">{t("allCapabilities")}</MenuItem>
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
                <MenuItem value="all">{t("allQualityTiers")}</MenuItem>
                <MenuItem value="built-in">{t("builtIn")}</MenuItem>
                <MenuItem value="community">{t("community")}</MenuItem>
              </Select>
            </FormControl>
          </Stack>
        }
        pagination={<AdminTablePagination {...paginationProps} />}
      >
        {summary && summary.unknown > 0 && (
          <CompactAlert severity="warning">
            {t("unknownServices", { count: summary.unknown })}
          </CompactAlert>
        )}
        {isError && (
          <CompactAlert
            severity="error"
            variant="outlined"
            action={
              <Button color="inherit" size="small" onClick={() => refetch()}>
                {tCommon("retry")}
              </Button>
            }
          >
            {t("failedToLoadServicesThe")}
          </CompactAlert>
        )}
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    slotProps={{ input: { "aria-label": t("selectVisibleServices") } }}
                    checked={allVisibleSelected}
                    indeterminate={selectedIds.size > 0 && !allVisibleSelected}
                    onChange={toggleSelectVisible}
                  />
                </TableCell>
                <TableCell>{t("service")}</TableCell>
                <TableCell>{t("version")}</TableCell>
                <TableCell>{t("quality")}</TableCell>
                <TableCell>{t("provides")}</TableCell>
                <TableCell>{t("status")}</TableCell>
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
                      ? t("noServicesRegisteredYet")
                      : t("noServicesMatchTheCurrent")
                  }
                />
              ) : (
                paged.map((svc) => (
                  <TableRow key={svc.id} hover>
                    <TableCell padding="checkbox">
                      <Checkbox
                        size="small"
                        slotProps={{ input: { "aria-label": t("selectId", { id: svc.id }) } }}
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
                          href={`/admin/system/services/${encodeURIComponent(svc.id)}`}
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
                        {svc.enabled ? t("enabled") : t("disabled")}
                      </Typography>
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
          {t("showingServices", {
            shown: filtered.length,
            total: services.length,
          })}
        </Typography>
      )}
    </Stack>
  );
}
