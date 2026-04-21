"use client";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DnsIcon from "@mui/icons-material/Dns";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExtensionIcon from "@mui/icons-material/Extension";
import GroupIcon from "@mui/icons-material/Group";
import KeyIcon from "@mui/icons-material/Key";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Grid from "@mui/material/Grid";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";

// Types

interface AttentionItem {
  type: string;
  severity: "warning" | "error" | "info";
  message: string;
  target?: string;
}

interface AuditEntry {
  id: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

interface JobEntry {
  id: string;
  type: string;
  status: string;
  progress?: number;
  createdAt: string;
  finishedAt?: string;
  error?: string;
}

interface OverviewData {
  systemHealth: { status: "pass" | "degraded" | "down"; unhealthyCount: number };
  users: { total: number; active24h: number; banned: number };
  integrations: { total: number; enabled: number; unhealthy: number; unconfigured: number };
  services: { running: number; stopped: number; unhealthy: number } | null;
  attention: AttentionItem[];
  recentActivity: AuditEntry[];
  activeJobs: JobEntry[];
}

interface CredentialsOverviewData {
  credentials: Array<{
    integrationId: string;
    name: string;
    enabled: boolean;
    secretFields: number;
    vaultStored: number;
    missingCredentials: number;
  }>;
  secretsConfigured: boolean;
}

// Components

function StatCard({
  title,
  icon,
  href,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Card variant="outlined">
      <CardActionArea component={Link} href={href} sx={{ height: "100%" }}>
        <CardContent>
          <Stack direction="row" alignItems="center" gap={1} mb={1.5}>
            <Box sx={{ color: "primary.main" }}>{icon}</Box>
            <Typography variant="subtitle2" color="text.secondary">
              {title}
            </Typography>
          </Stack>
          {children}
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

function HealthBadge({ status }: { status: "pass" | "degraded" | "down" }) {
  const map = {
    pass: {
      label: "All Systems Operational",
      color: "success" as const,
      icon: <CheckCircleOutlineIcon fontSize="small" />,
    },
    degraded: {
      label: "Degraded",
      color: "warning" as const,
      icon: <WarningAmberIcon fontSize="small" />,
    },
    down: {
      label: "Major Outage",
      color: "error" as const,
      icon: <ErrorOutlineIcon fontSize="small" />,
    },
  };
  const info = map[status];
  return (
    <Chip icon={info.icon} label={info.label} color={info.color} size="small" variant="outlined" />
  );
}

function attentionHref(item: AttentionItem): string {
  if (item.type === "missing_credentials" || item.type === "health_check_failed") {
    return `/admin/integrations/${item.target}`;
  }
  if (item.type === "job_failed") return "/admin/activity";
  if (item.type === "service_unhealthy") return "/admin/services";
  return "/admin";
}

function jobStatusColor(status: string): "default" | "success" | "error" | "warning" | "info" {
  if (status === "success") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "info";
  if (status === "queued") return "warning";
  return "default";
}

// Main

export function AdminOverview() {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();
  const showToast = useAdminToast();

  const { data, isLoading } = useQuery<OverviewData>({
    queryKey: ["admin", "overview"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/overview`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load overview");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const credentialsOverview = useQuery<CredentialsOverviewData>({
    queryKey: ["admin", "credentials", "overview"],
    queryFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/credentials`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load credentials overview");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const healthSweep = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/health/run`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Health check failed");
      return res.json();
    },
    onSuccess: () => {
      showToast("Health checks complete");
      qc.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
    onError: () => showToast("Health check sweep failed", "error"),
  });

  const reloadMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/integrations/reload`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Reload failed");
      return res.json();
    },
    onSuccess: () => {
      showToast("Reload job queued");
      qc.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
    onError: () => showToast("Reload failed", "error"),
  });

  if (isLoading) {
    return (
      <Stack gap={3}>
        <Typography variant="h5" fontWeight={700}>
          Overview
        </Typography>
        <Grid container spacing={2}>
          {[1, 2, 3, 4].map((i) => (
            <Grid key={i} size={{ xs: 12, sm: 6, md: 3 }}>
              <Skeleton variant="rounded" height={130} />
            </Grid>
          ))}
        </Grid>
      </Stack>
    );
  }

  if (!data) return <Alert severity="error">Failed to load overview data.</Alert>;

  const isBusy = healthSweep.isPending || reloadMutation.isPending;
  const credentials = credentialsOverview.data?.credentials ?? [];
  const missingCredentialIntegrations = credentials.filter((entry) => entry.missingCredentials > 0);
  const totalMissingCredentials = missingCredentialIntegrations.reduce(
    (sum, entry) => sum + entry.missingCredentials,
    0,
  );

  return (
    <Stack gap={3}>
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        flexWrap="wrap"
        gap={1}
      >
        <Typography variant="h5" fontWeight={700}>
          Overview
        </Typography>
        <HealthBadge status={data.systemHealth.status} />
      </Stack>

      {/* Summary cards */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="System Health" icon={<CheckCircleOutlineIcon />} href="/admin/status">
            <Typography
              variant="h4"
              fontWeight={700}
              color={
                data.systemHealth.status === "pass"
                  ? "success.main"
                  : data.systemHealth.status === "degraded"
                    ? "warning.main"
                    : "error.main"
              }
            >
              {data.systemHealth.status === "pass" ? "OK" : data.systemHealth.unhealthyCount}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {data.systemHealth.status === "pass"
                ? "All systems operational"
                : `${data.systemHealth.unhealthyCount} unhealthy`}
            </Typography>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Users" icon={<GroupIcon />} href="/admin/users">
            <Typography variant="h4" fontWeight={700}>
              {data.users.total}
            </Typography>
            <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
              <Chip
                label={`${data.users.active24h} active`}
                size="small"
                color="success"
                variant="outlined"
              />
              {data.users.banned > 0 && (
                <Chip
                  label={`${data.users.banned} banned`}
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
            </Stack>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Integrations" icon={<ExtensionIcon />} href="/admin/integrations">
            <Typography variant="h4" fontWeight={700}>
              {data.integrations.total}
            </Typography>
            <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
              <Chip
                label={`${data.integrations.enabled} enabled`}
                size="small"
                color="success"
                variant="outlined"
              />
              {data.integrations.unhealthy > 0 && (
                <Chip
                  label={`${data.integrations.unhealthy} unhealthy`}
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
              {data.integrations.unconfigured > 0 && (
                <Chip
                  label={`${data.integrations.unconfigured} unconfigured`}
                  size="small"
                  color="warning"
                  variant="outlined"
                />
              )}
            </Stack>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          {data.services ? (
            <StatCard title="Services" icon={<DnsIcon />} href="/admin/services">
              <Typography variant="h4" fontWeight={700}>
                {data.services.running}
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
                <Chip
                  label={`${data.services.running} running`}
                  size="small"
                  color="success"
                  variant="outlined"
                />
                <Chip label={`${data.services.stopped} stopped`} size="small" variant="outlined" />
                {data.services.unhealthy > 0 && (
                  <Chip
                    label={`${data.services.unhealthy} unhealthy`}
                    size="small"
                    color="error"
                    variant="outlined"
                  />
                )}
              </Stack>
            </StatCard>
          ) : (
            <StatCard title="Services" icon={<DnsIcon />} href="/admin/status">
              <Typography variant="h4" fontWeight={700} color="text.secondary">
                N/A
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Cloud deployment
              </Typography>
            </StatCard>
          )}
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <StatCard title="Credentials" icon={<KeyIcon />} href="/admin/integrations">
            <Typography
              variant="h4"
              fontWeight={700}
              color={totalMissingCredentials > 0 ? "warning.main" : "success.main"}
            >
              {totalMissingCredentials}
            </Typography>
            <Stack direction="row" gap={0.5} flexWrap="wrap" mt={0.5}>
              <Chip
                label={`${credentials.length} integration${credentials.length === 1 ? "" : "s"}`}
                size="small"
                variant="outlined"
              />
              <Chip
                label={
                  totalMissingCredentials > 0
                    ? `${missingCredentialIntegrations.length} missing`
                    : "all configured"
                }
                size="small"
                color={totalMissingCredentials > 0 ? "warning" : "success"}
                variant="outlined"
              />
            </Stack>
          </StatCard>
        </Grid>
      </Grid>

      {/* Attention list */}
      {data.attention.length > 0 && (
        <Box>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Needs Attention
          </Typography>
          <Stack gap={1}>
            {data.attention.map((item) => (
              <Alert
                key={`${item.type}-${item.message}`}
                severity={item.severity}
                variant="outlined"
                action={
                  <Button component={Link} href={attentionHref(item)} size="small" color="inherit">
                    View
                  </Button>
                }
                sx={{ py: 0, "& .MuiAlert-action": { alignItems: "center", pt: 0 } }}
              >
                {item.message}
              </Alert>
            ))}
          </Stack>
        </Box>
      )}

      {credentialsOverview.isError && (
        <Alert severity="error" variant="outlined">
          Failed to load credentials summary.
        </Alert>
      )}

      {credentials.length > 0 && (
        <Box>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Credentials Overview
          </Typography>
          {!credentialsOverview.data?.secretsConfigured && (
            <Alert severity="warning" sx={{ mb: 1.25 }}>
              Credentials vault is not configured. Set <code>OPENMAPX_SECRETS_KEY</code> to enable
              secure storage in the admin UI.
            </Alert>
          )}
          {missingCredentialIntegrations.length === 0 ? (
            <Alert severity="success" variant="outlined">
              No missing integration credentials detected.
            </Alert>
          ) : (
            <Stack gap={1}>
              {missingCredentialIntegrations.slice(0, 6).map((entry) => (
                <Alert
                  key={entry.integrationId}
                  severity="warning"
                  variant="outlined"
                  action={
                    <Button
                      component={Link}
                      href={`/admin/integrations/${entry.integrationId}`}
                      size="small"
                      color="inherit"
                    >
                      Open
                    </Button>
                  }
                >
                  {entry.name}: {entry.missingCredentials} missing credential
                  {entry.missingCredentials === 1 ? "" : "s"}
                </Alert>
              ))}
            </Stack>
          )}
        </Box>
      )}

      {/* Quick actions */}
      <Box>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>
          Quick Actions
        </Typography>
        <Stack direction="row" gap={1} flexWrap="wrap">
          <Button
            variant="outlined"
            size="small"
            startIcon={<PlayArrowIcon />}
            onClick={() => healthSweep.mutate()}
            disabled={isBusy}
          >
            {healthSweep.isPending ? "Running..." : "Run Health Checks"}
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshIcon />}
            onClick={() => reloadMutation.mutate()}
            disabled={isBusy}
          >
            {reloadMutation.isPending ? "Reloading..." : "Reload Integrations"}
          </Button>
        </Stack>
      </Box>

      <Divider />

      {/* Bottom row: Recent Activity + Active Jobs */}
      <Grid container spacing={3}>
        {/* Recent Activity */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Recent Activity
          </Typography>
          {data.recentActivity.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No recent activity.
            </Typography>
          ) : (
            <Stack gap={0.5}>
              {data.recentActivity.map((entry) => (
                <Stack
                  key={entry.id}
                  direction="row"
                  alignItems="center"
                  gap={1}
                  py={0.5}
                  sx={{ borderBottom: "1px solid", borderColor: "divider" }}
                >
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ minWidth: 120, fontFamily: "monospace" }}
                  >
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Typography>
                  <Chip
                    label={entry.action}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: 11, height: 20 }}
                  />
                  {entry.targetId && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      noWrap
                      sx={{ maxWidth: 200 }}
                    >
                      {entry.targetId}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
          <Button component={Link} href="/admin/activity" size="small" sx={{ mt: 1 }}>
            View All Activity
          </Button>
        </Grid>

        {/* Active Jobs */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Typography variant="subtitle1" fontWeight={600} gutterBottom>
            Jobs
          </Typography>
          {data.activeJobs.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No recent jobs.
            </Typography>
          ) : (
            <Stack gap={0.5}>
              {data.activeJobs.map((job) => (
                <Stack
                  key={job.id}
                  direction="row"
                  alignItems="center"
                  gap={1}
                  py={0.5}
                  sx={{ borderBottom: "1px solid", borderColor: "divider" }}
                >
                  <Chip
                    label={job.status}
                    size="small"
                    color={jobStatusColor(job.status)}
                    variant="outlined"
                    sx={{ fontSize: 10, height: 18, minWidth: 60 }}
                  />
                  <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                    {job.type}
                  </Typography>
                  {job.status === "running" && job.progress != null && (
                    <Tooltip title={`${job.progress}%`}>
                      <CircularProgress size={16} variant="determinate" value={job.progress} />
                    </Tooltip>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {new Date(job.finishedAt ?? job.createdAt).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          )}
          <Button component={Link} href="/admin/activity" size="small" sx={{ mt: 1 }}>
            View All Jobs
          </Button>
        </Grid>
      </Grid>
    </Stack>
  );
}
