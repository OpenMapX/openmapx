"use client";

import FilterListIcon from "@mui/icons-material/FilterList";
import HealthAndSafetyIcon from "@mui/icons-material/HealthAndSafety";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControl from "@mui/material/FormControl";
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
import { useMemo, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";
import { DomainChip } from "./DomainChip";
import { computeStatusVariant, IntegrationStatusDot } from "./IntegrationStatusDot";
import { StatusBadge } from "./StatusBadge";

export interface IntegrationSummary {
  id: string;
  name: string;
  description?: string;
  version?: string;
  domains: string[];
  quality: "built-in" | "community-verified" | "community";
  isBuiltIn: boolean;
  enabled: boolean;
  configured: boolean;
  hasHealthCheck: boolean;
  health: { status: "up" | "down" | "unconfigured"; responseTime?: number; error?: string } | null;
  dependencies: string[];
  infrastructure: { dockerProfile?: string; services?: string[] } | null;
}

type StatusFilter = "all" | "enabled" | "disabled" | "unhealthy" | "unconfigured";
type QualityFilter = "all" | "built-in" | "community";

function HealthCell({ integration }: { integration: IntegrationSummary }) {
  if (!integration.hasHealthCheck) {
    return (
      <Typography variant="body2" color="text.disabled">
        N/A
      </Typography>
    );
  }
  if (!integration.health) {
    return (
      <Typography variant="body2" color="text.disabled">
        —
      </Typography>
    );
  }
  if (integration.health.status === "unconfigured") {
    return <Chip label="Unconfigured" size="small" color="warning" variant="outlined" />;
  }
  if (integration.health.status === "down") {
    return (
      <Tooltip title={integration.health.error ?? "Unhealthy"}>
        <Chip label="Down" size="small" color="error" variant="outlined" />
      </Tooltip>
    );
  }
  return (
    <Typography variant="body2" color="success.main" fontWeight={500}>
      {integration.health.responseTime != null ? `${integration.health.responseTime}ms` : "Up"}
    </Typography>
  );
}

export function IntegrationList() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [domainFilter, setDomainFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const showToast = useAdminToast();
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const {
    data: integrations = [],
    isLoading,
    isError,
  } = useQuery<IntegrationSummary[]>({
    queryKey: ["admin", "integrations"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load integrations");
      return res.json();
    },
  });

  async function toggleIntegration(integrationId: string, enable: boolean) {
    setTogglingIds((prev) => new Set(prev).add(integrationId));
    try {
      const action = enable ? "enable" : "disable";
      const res = await fetch(`${apiUrl}/api/admin/integrations/${integrationId}/${action}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Failed to ${action}`);
      qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
      showToast(`Integration ${enable ? "enabled" : "disabled"}`);
    } catch {
      showToast("Operation failed", "error");
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(integrationId);
        return next;
      });
    }
  }

  const reloadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/reload`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Reload failed");
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
      showToast(`Reloaded ${data.reloaded} integrations (${data.enabled} enabled)`);
    },
    onError: () => showToast("Reload failed", "error"),
  });

  const healthMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/health/run`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Health check failed");
      return res.json();
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations"] });
      showToast(`Health checks completed: ${data.count} checked`);
    },
    onError: () => showToast("Health checks failed", "error"),
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
      <Stack gap={2}>
        <Skeleton variant="text" width={200} height={40} />
        <Stack direction="row" gap={1}>
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
    return <Alert severity="error">Failed to load integrations</Alert>;
  }

  return (
    <Stack gap={3}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="h5" fontWeight={700}>
          Integrations
        </Typography>
        <Stack direction="row" gap={0.75} flexWrap="wrap">
          <Chip label={`${integrations.length} total`} size="small" variant="outlined" />
          <Chip
            label={`${counts.enabled} enabled`}
            size="small"
            color="success"
            variant="outlined"
          />
          <Chip label={`${counts.disabled} disabled`} size="small" variant="outlined" />
          {counts.unhealthy > 0 && (
            <Chip
              label={`${counts.unhealthy} unhealthy`}
              size="small"
              color="error"
              variant="outlined"
            />
          )}
          {counts.unconfigured > 0 && (
            <Chip
              label={`${counts.unconfigured} unconfigured`}
              size="small"
              color="warning"
              variant="outlined"
            />
          )}
        </Stack>
      </Stack>

      <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
        <TextField
          size="small"
          placeholder="Search by name, id, domain…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          sx={{ minWidth: 260 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />

        <FormControl size="small" sx={{ minWidth: 140 }}>
          <Select
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            displayEmpty
            startAdornment={
              <FilterListIcon fontSize="small" sx={{ mr: 0.5, color: "text.secondary" }} />
            }
          >
            <MenuItem value="all">All domains</MenuItem>
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
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <MenuItem value="all">All statuses</MenuItem>
            <MenuItem value="enabled">Enabled</MenuItem>
            <MenuItem value="disabled">Disabled</MenuItem>
            <MenuItem value="unhealthy">Unhealthy</MenuItem>
            <MenuItem value="unconfigured">Unconfigured</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 130 }}>
          <Select
            value={qualityFilter}
            onChange={(e) => setQualityFilter(e.target.value as QualityFilter)}
          >
            <MenuItem value="all">All types</MenuItem>
            <MenuItem value="built-in">Built-in</MenuItem>
            <MenuItem value="community">Community</MenuItem>
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
            }}
          >
            Clear
          </Button>
        )}
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 32 }} />
              <TableCell>Name</TableCell>
              <TableCell>Domains</TableCell>
              <TableCell>Version</TableCell>
              <TableCell>Quality</TableCell>
              <TableCell>Health</TableCell>
              <TableCell>Enabled</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Typography variant="body2" color="text.secondary" align="center" py={3}>
                    No integrations match your filters
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {filtered.map((integration) => (
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
                  <Stack gap={0.25}>
                    <Typography
                      component={Link}
                      href={`/admin/integrations/${integration.id}`}
                      variant="body2"
                      fontWeight={600}
                      lineHeight={1.2}
                      sx={{ textDecoration: "none", color: "primary.main" }}
                    >
                      {integration.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {integration.id}
                    </Typography>
                  </Stack>
                </TableCell>
                <TableCell>
                  <Stack direction="row" gap={0.5} flexWrap="wrap">
                    {integration.domains.map((d) => (
                      <DomainChip key={d} domain={d} />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">
                    {integration.version ?? "—"}
                  </Typography>
                </TableCell>
                <TableCell>
                  <StatusBadge quality={integration.quality} />
                </TableCell>
                <TableCell>
                  <HealthCell integration={integration} />
                </TableCell>
                <TableCell>
                  <Tooltip
                    title={integration.enabled ? "Disable integration" : "Enable integration"}
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

      <Divider />

      <Stack direction="row" gap={1.5} justifyContent="flex-end">
        <Button
          variant="outlined"
          size="small"
          startIcon={
            healthMutation.isPending ? <CircularProgress size={14} /> : <HealthAndSafetyIcon />
          }
          onClick={() => healthMutation.mutate()}
          disabled={healthMutation.isPending || reloadMutation.isPending}
        >
          Run Health Checks
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={reloadMutation.isPending ? <CircularProgress size={14} /> : <RefreshIcon />}
          onClick={() => reloadMutation.mutate()}
          disabled={reloadMutation.isPending || healthMutation.isPending}
        >
          Reload All
        </Button>
      </Stack>
    </Stack>
  );
}
