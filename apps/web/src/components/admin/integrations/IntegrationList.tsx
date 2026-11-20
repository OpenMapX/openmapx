"use client";

import FilterListIcon from "@mui/icons-material/FilterList";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import RefreshIcon from "@mui/icons-material/Refresh";
import TuneIcon from "@mui/icons-material/Tune";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import FormControl from "@mui/material/FormControl";
import MenuItem from "@mui/material/MenuItem";
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
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useIntegrationAdmin, useIntegrationReload } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { TableEmptyState } from "../shared/TableEmptyState";
import { TableSearchField, TableToolbar } from "../shared/TableToolbar";
import { DomainChip } from "./DomainChip";
import { computeStatusVariant, IntegrationStatusDot } from "./IntegrationStatusDot";
import { StatusBadge } from "./StatusBadge";

export type IntegrationSummary = import("@openmapx/core/api-contracts").AdminIntegrationSummary;

type StatusFilter = "all" | "enabled" | "disabled" | "unhealthy" | "unconfigured";
type QualityFilter = "all" | "built-in" | "community";

function HealthCell({ integration }: { integration: IntegrationSummary }) {
  const t = useTranslations("adminIntegrations");
  if (!integration.hasHealthCheck) {
    return (
      <Typography
        variant="body2"
        sx={{
          color: "text.disabled",
        }}
      >
        {t("notApplicable")}
      </Typography>
    );
  }
  if (!integration.health) {
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
  if (integration.health.status === "unconfigured") {
    return <Chip label={t("unconfigured")} size="small" color="warning" variant="outlined" />;
  }
  if (integration.health.status === "down") {
    return (
      <Tooltip title={integration.health.error ?? t("unhealthy")}>
        <Chip label={t("down")} size="small" color="error" variant="outlined" />
      </Tooltip>
    );
  }
  return (
    <Typography
      variant="body2"
      sx={{
        color: "success.main",
        fontWeight: 500,
      }}
    >
      {integration.health.responseTime != null
        ? t("responsetimeMs", { responseTime: integration.health.responseTime })
        : t("up")}
    </Typography>
  );
}

export function IntegrationList() {
  const t = useTranslations("adminIntegrations");
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client);

  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);
  const showToast = useAdminToast();
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (owner.active) setTogglingIds(new Set());
  }, [owner]);

  const { data: integrations = [], isLoading, isError } = useQuery(admin.queries.list());

  async function toggleIntegration(integrationId: string, enable: boolean) {
    setTogglingIds((prev) => new Set(prev).add(integrationId));
    try {
      await admin.toggle(integrationId, enable);
      void admin.refresh();
      if (owner.active)
        showToast(t("integrationValue", { value: enable ? "enabled" : "disabled" }));
    } catch {
      if (owner.active) showToast(t("operationFailed"), "error");
    } finally {
      if (owner.active)
        setTogglingIds((prev) => {
          const next = new Set(prev);
          next.delete(integrationId);
          return next;
        });
    }
  }

  const reloadMutation = useIntegrationReload();

  const healthMutation = useMutation({
    mutationKey: ["integration-health-sweep", admin.apiUrl],
    retry: false,
    mutationFn: async () => {
      try {
        const data = await admin.healthSweep();
        void admin.refresh();
        if (owner.active) showToast(t("healthChecksCompletedCountChecked", { count: data.count }));
      } catch (err) {
        if (owner.active) showToast(t("healthChecksFailed"), "error");
        throw err;
      }
    },
  });

  const allDomains = useMemo(
    () => Array.from(new Set(integrations.flatMap((i) => i.domains))).sort(),
    [integrations],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return integrations.filter((i) => {
      if (
        q &&
        !i.name.toLowerCase().includes(q) &&
        !i.id.toLowerCase().includes(q) &&
        !i.domains.some((d) => d.includes(q))
      )
        return false;
      if (domainFilter !== "all" && !i.domains.includes(domainFilter)) return false;
      if (qualityFilter !== "all") {
        if (qualityFilter === "built-in" && !i.isBuiltIn) return false;
        if (qualityFilter === "community" && i.isBuiltIn) return false;
      }
      if (statusFilter !== "all") {
        const variant = computeStatusVariant(i.enabled, i.configured, i.health, i.hasHealthCheck);
        if (statusFilter === "enabled" && !i.enabled) return false;
        if (statusFilter === "disabled" && i.enabled) return false;
        if (statusFilter === "unhealthy" && variant !== "unhealthy") return false;
        if (statusFilter === "unconfigured" && variant !== "unconfigured") return false;
      }
      return true;
    });
  }, [integrations, search, domainFilter, statusFilter, qualityFilter]);

  const paged = useMemo(
    () => filtered.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage),
    [filtered, page, rowsPerPage],
  );

  const counts = useMemo(() => {
    const enabled = integrations.filter((i) => i.enabled).length;
    const disabled = integrations.length - enabled;
    const unhealthy = integrations.filter(
      (i) =>
        computeStatusVariant(i.enabled, i.configured, i.health, i.hasHealthCheck) === "unhealthy",
    ).length;
    const unconfigured = integrations.filter(
      (i) =>
        computeStatusVariant(i.enabled, i.configured, i.health, i.hasHealthCheck) ===
        "unconfigured",
    ).length;
    return { enabled, disabled, unhealthy, unconfigured };
  }, [integrations]);

  if (isLoading) {
    return (
      <Stack
        sx={{
          gap: 2,
        }}
      >
        <Skeleton variant="text" width={200} height={40} />
        <Stack
          direction="row"
          sx={{
            gap: 1,
          }}
        >
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} variant="rounded" width={100} height={24} />
          ))}
        </Stack>
        <Skeleton variant="rounded" height={48} />
        {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <Skeleton key={i} variant="rounded" height={52} />
        ))}
      </Stack>
    );
  }

  if (isError) {
    return <Alert severity="error">{t("failedToLoadIntegrations")}</Alert>;
  }

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      <AdminPageHeader
        title={t("integrations")}
        subtitle={t("providersCredentialsHealth")}
        actions={
          <Stack
            direction="row"
            sx={{
              gap: 0.75,
              flexWrap: "wrap",
            }}
          >
            <Chip
              label={t("lengthTotal", { length: integrations.length })}
              size="small"
              variant="outlined"
            />
            <Chip
              label={t("enabledEnabled", { enabled: counts.enabled })}
              size="small"
              color="success"
              variant="outlined"
            />
            <Chip
              label={t("disabledDisabled", { disabled: counts.disabled })}
              size="small"
              variant="outlined"
            />
            {counts.unhealthy > 0 && (
              <Chip
                label={t("unhealthyUnhealthy", { unhealthy: counts.unhealthy })}
                size="small"
                color="error"
                variant="outlined"
              />
            )}
            {counts.unconfigured > 0 && (
              <Chip
                label={t("unconfiguredUnconfigured", { unconfigured: counts.unconfigured })}
                size="small"
                color="warning"
                variant="outlined"
              />
            )}
          </Stack>
        }
      />
      <AdminTableSurface
        toolbar={
          <TableToolbar>
            <TableSearchField
              placeholder={t("searchByNameIdDomain")}
              value={search}
              onChange={(value) => {
                setSearch(value);
                setPage(0);
              }}
              minWidth={260}
            />

            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={domainFilter}
                onChange={(e) => {
                  setDomainFilter(e.target.value);
                  setPage(0);
                }}
                displayEmpty
                startAdornment={
                  <FilterListIcon fontSize="small" sx={{ mr: 0.5, color: "text.secondary" }} />
                }
              >
                <MenuItem value="all">{t("allDomains")}</MenuItem>
                {allDomains.map((d) => (
                  <MenuItem key={d} value={d}>
                    {d}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as StatusFilter);
                  setPage(0);
                }}
              >
                <MenuItem value="all">{t("allStatuses")}</MenuItem>
                <MenuItem value="enabled">{t("enabled")}</MenuItem>
                <MenuItem value="disabled">{t("disabled")}</MenuItem>
                <MenuItem value="unhealthy">{t("unhealthy")}</MenuItem>
                <MenuItem value="unconfigured">{t("unconfigured")}</MenuItem>
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
              <Select
                value={qualityFilter}
                onChange={(e) => {
                  setQualityFilter(e.target.value as QualityFilter);
                  setPage(0);
                }}
              >
                <MenuItem value="all">{t("allTypes")}</MenuItem>
                <MenuItem value="built-in">{t("builtIn")}</MenuItem>
                <MenuItem value="community">{t("community")}</MenuItem>
              </Select>
            </FormControl>

            {(search ||
              domainFilter !== "all" ||
              statusFilter !== "all" ||
              qualityFilter !== "all") && (
              <Button
                size="small"
                variant="text"
                onClick={() => {
                  setSearch("");
                  setDomainFilter("all");
                  setStatusFilter("all");
                  setQualityFilter("all");
                  setPage(0);
                }}
              >
                {t("clear")}
              </Button>
            )}

            <Stack
              direction="row"
              sx={{
                gap: 1.5,
                flexWrap: "wrap",
                ml: { sm: "auto" },
              }}
            >
              <Button
                component={Link}
                href="/admin/integrations/bulk"
                variant="outlined"
                size="small"
                startIcon={<TuneIcon />}
              >
                {t("bulkConfigure")}
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={
                  healthMutation.isPending ? (
                    <CircularProgress size={14} />
                  ) : (
                    <HealthAndSafetyIcon />
                  )
                }
                onClick={() => healthMutation.mutate()}
                disabled={healthMutation.isPending || reloadMutation.isPending}
              >
                {t("runHealthChecks")}
              </Button>
              <Button
                variant="outlined"
                size="small"
                startIcon={
                  reloadMutation.isPending ? <CircularProgress size={14} /> : <RefreshIcon />
                }
                onClick={() =>
                  reloadMutation.mutate(undefined, {
                    onSuccess: () =>
                      owner.active && showToast(t("reloadJobQueuedCheckActivity"), "info"),
                    onError: () => {
                      if (owner.active) showToast(t("reloadFailed"), "error");
                    },
                  })
                }
                disabled={reloadMutation.isPending || healthMutation.isPending}
              >
                {t("reloadAll")}
              </Button>
            </Stack>
          </TableToolbar>
        }
        pagination={
          <AdminTablePagination
            count={filtered.length}
            page={page}
            rowsPerPage={rowsPerPage}
            onPageChange={(_, nextPage) => setPage(nextPage)}
            onRowsPerPageChange={(event) => {
              setRowsPerPage(Number(event.target.value));
              setPage(0);
            }}
          />
        }
      >
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 32 }} />
                <TableCell>{t("name")}</TableCell>
                <TableCell>{t("domains")}</TableCell>
                <TableCell>{t("version")}</TableCell>
                <TableCell>{t("quality")}</TableCell>
                <TableCell>{t("health")}</TableCell>
                <TableCell>{t("enabled")}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.length === 0 && (
                <TableEmptyState colSpan={7} message={t("noIntegrationsMatchYourFilters")} />
              )}
              {paged.map((integration) => (
                <TableRow key={integration.id} hover>
                  <TableCell>
                    <IntegrationStatusDot
                      enabled={integration.enabled}
                      configured={integration.configured}
                      health={integration.health}
                      hasHealthCheck={integration.hasHealthCheck}
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
                        href={`/admin/integrations/${integration.id}`}
                        variant="body2"
                        sx={{
                          fontWeight: 600,
                          lineHeight: 1.2,
                          textDecoration: "none",
                          color: "primary.main",
                        }}
                      >
                        {integration.name}
                      </Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                        }}
                      >
                        {integration.id}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Stack
                      direction="row"
                      sx={{
                        gap: 0.5,
                        flexWrap: "wrap",
                      }}
                    >
                      {integration.domains.map((d) => (
                        <DomainChip key={d} domain={d} />
                      ))}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {integration.version ?? "—"}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" sx={{ gap: 0.5, flexWrap: "wrap" }}>
                      <StatusBadge quality={integration.quality} />
                      {integration.blockedCode ? (
                        <Tooltip title={t("thisCommunityIntegrationShipsBackend")}>
                          <Chip
                            label={t("codeNotExecuted")}
                            size="small"
                            color="warning"
                            variant="outlined"
                          />
                        </Tooltip>
                      ) : null}
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <HealthCell integration={integration} />
                  </TableCell>
                  <TableCell>
                    <Tooltip
                      title={integration.enabled ? t("disableIntegration") : t("enableIntegration")}
                    >
                      <span>
                        <Switch
                          size="small"
                          checked={integration.enabled}
                          disabled={togglingIds.has(integration.id)}
                          onChange={(e) => toggleIntegration(integration.id, e.target.checked)}
                        />
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </AdminTableSurface>
    </Stack>
  );
}
