"use client";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import DnsIcon from "@mui/icons-material/Dns";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import ExtensionIcon from "@mui/icons-material/Extension";
import GroupIcon from "@mui/icons-material/Group";
import KeyIcon from "@mui/icons-material/Key";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
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
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import { useIntegrationAdmin, useIntegrationReload } from "@/lib/admin/integrationAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { useAdminToast } from "../shared/AdminToast";
import { useAuditActionLabel } from "../shared/auditActionLabel";
import { CompactAlert } from "../shared/CompactAlert";
import { CompactAlertList } from "../shared/CompactAlertList";
import { jobStatusColor } from "../shared/jobStatus";

type AttentionItem = import("@openmapx/core/api-contracts").AdminOverview["attention"][number];

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
    <Card variant="outlined" sx={{ height: "100%" }}>
      <CardActionArea component={Link} href={href} sx={{ height: "100%" }}>
        <CardContent>
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1,
              mb: 1.5,
            }}
          >
            <Box sx={{ color: "primary.main" }}>{icon}</Box>
            <Typography
              variant="subtitle2"
              sx={{
                color: "text.secondary",
              }}
            >
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
  const t = useTranslations("adminOverview");
  const map = {
    pass: {
      label: t("allSystemsOperational"),
      color: "success" as const,
      icon: <CheckCircleOutlineIcon fontSize="small" />,
    },
    degraded: {
      label: t("degraded"),
      color: "warning" as const,
      icon: <WarningAmberIcon fontSize="small" />,
    },
    down: {
      label: t("majorOutage"),
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
  if (item.type === "service_unhealthy") return "/admin/system/services";
  return "/admin";
}

// Main

export function AdminOverview() {
  const t = useTranslations("adminOverview");
  const tShared = useTranslations("adminShared");
  const auditActionLabel = useAuditActionLabel();
  const format = useAdminFormat();
  const admin = useIntegrationAdmin();
  const owner = useAdminMutationOwner(admin.client);
  const showToast = useAdminToast();
  const [attentionExpanded, setAttentionExpanded] = useState(false);
  const [credentialsExpanded, setCredentialsExpanded] = useState(false);

  const { data, isLoading } = useQuery({ ...admin.queries.overview(), refetchInterval: 60_000 });
  const credentialsOverview = useQuery({ ...admin.queries.credentials(), refetchInterval: 60_000 });

  const healthSweep = useMutation({
    mutationKey: ["integration-health-sweep", admin.apiUrl],
    retry: false,
    mutationFn: async () => {
      try {
        await admin.healthSweep();
        void admin.refresh();
        if (owner.active) showToast(t("healthChecksComplete"));
      } catch (err) {
        if (owner.active) showToast(t("healthCheckSweepFailed"), "error");
        throw err;
      }
    },
  });

  const reloadMutation = useIntegrationReload();

  if (isLoading) {
    return (
      <Stack
        sx={{
          gap: 3,
        }}
      >
        <AdminPageHeader title={t("overview")} />
        <Grid container spacing={2}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Grid key={i} size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
              <Skeleton variant="rounded" height={130} />
            </Grid>
          ))}
        </Grid>
      </Stack>
    );
  }

  if (!data) {
    return (
      <CompactAlert severity="error" variant="outlined">
        {t("failedToLoadOverviewData")}
      </CompactAlert>
    );
  }

  const isBusy = healthSweep.isPending || reloadMutation.isPending;
  const credentials = credentialsOverview.data?.credentials ?? [];
  const missingCredentialIntegrations = credentials.filter((entry) => entry.missingCredentials > 0);
  const totalMissingCredentials = missingCredentialIntegrations.reduce(
    (sum, entry) => sum + entry.missingCredentials,
    0,
  );
  const generalAttention = data.attention.filter((item) => item.type !== "missing_credentials");

  return (
    <Stack
      sx={{
        gap: 2,
      }}
    >
      {/* Header */}
      <AdminPageHeader
        title={t("overview")}
        subtitle={t("systemHealthAndRecentOperations")}
        actions={
          <>
            <HealthBadge status={data.systemHealth.status} />
            <Button
              variant="outlined"
              startIcon={<PlayArrowIcon />}
              onClick={() => healthSweep.mutate()}
              disabled={isBusy}
            >
              {healthSweep.isPending ? t("running") : t("healthChecks")}
            </Button>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={() =>
                reloadMutation.mutate(undefined, {
                  onSuccess: () => {
                    if (owner.active) showToast(t("reloadJobQueued"), "info");
                  },
                  onError: () => {
                    if (owner.active) showToast(t("reloadFailed"), "error");
                  },
                })
              }
              disabled={isBusy}
            >
              {reloadMutation.isPending ? t("reloading") : t("reload")}
            </Button>
          </>
        }
      />

      {/* Attention list */}
      {generalAttention.length > 0 && (
        <Box>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{
              fontWeight: 600,
            }}
          >
            {t("needsAttention")}
          </Typography>
          <CompactAlertList
            items={generalAttention.map((item) => ({
              id: `${item.type}-${item.message}`,
              severity: item.severity,
              message: item.message,
              href: attentionHref(item),
              actionLabel: t("view"),
            }))}
            expanded={attentionExpanded}
            onExpandedChange={setAttentionExpanded}
          />
        </Box>
      )}
      {credentialsOverview.isError && (
        <CompactAlert severity="error" variant="outlined">
          {t("failedToLoadCredentialsSummary")}
        </CompactAlert>
      )}
      {credentials.length > 0 && (
        <Box>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{
              fontWeight: 600,
            }}
          >
            {t("credentialsOverview")}
          </Typography>
          {!credentialsOverview.data?.secretsConfigured && (
            <CompactAlert severity="warning" variant="outlined" sx={{ mb: 1.25 }}>
              {t.rich("credentialsVaultNotConfigured", {
                variable: "OPENMAPX_SECRETS_KEY",
                code: (chunks) => <code>{chunks}</code>,
              })}
            </CompactAlert>
          )}
          {missingCredentialIntegrations.length === 0 ? (
            <CompactAlert severity="success" variant="outlined">
              {t("noMissingIntegrationCredentialsDetected")}
            </CompactAlert>
          ) : (
            <CompactAlertList
              items={missingCredentialIntegrations.map((entry) => ({
                id: entry.integrationId,
                severity: "warning",
                message: t("missingCredentials", {
                  name: entry.name,
                  missingCredentials: entry.missingCredentials,
                }),
                href: `/admin/integrations/${entry.integrationId}`,
                actionLabel: t("open"),
              }))}
              expanded={credentialsExpanded}
              onExpandedChange={setCredentialsExpanded}
            />
          )}
        </Box>
      )}
      <Divider />
      {/* Bottom row: Recent Activity + Active Jobs */}
      <Grid container spacing={3}>
        {/* Recent Activity */}
        <Grid size={{ xs: 12, md: 7 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{
              fontWeight: 600,
            }}
          >
            {t("recentActivity")}
          </Typography>
          {data.recentActivity.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("noRecentActivity")}
            </Typography>
          ) : (
            <Stack
              sx={{
                gap: 0.5,
              }}
            >
              {data.recentActivity.map((entry) => (
                <Stack
                  key={entry.id}
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                    py: 0.5,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                      minWidth: 120,
                      fontFamily: "monospace",
                    }}
                  >
                    {format.dateTime(entry.createdAt)}
                  </Typography>
                  <Chip
                    label={auditActionLabel(entry.action)}
                    size="small"
                    variant="outlined"
                    sx={{ fontSize: 11, height: 20 }}
                  />
                  {entry.targetId && (
                    <Typography
                      variant="caption"
                      noWrap
                      sx={{
                        color: "text.secondary",
                        maxWidth: 200,
                      }}
                    >
                      {entry.targetId}
                    </Typography>
                  )}
                </Stack>
              ))}
            </Stack>
          )}
          <Button component={Link} href="/admin/activity" size="small" sx={{ mt: 1 }}>
            {t("viewAllActivity")}
          </Button>
        </Grid>

        {/* Active Jobs */}
        <Grid size={{ xs: 12, md: 5 }}>
          <Typography
            variant="subtitle1"
            gutterBottom
            sx={{
              fontWeight: 600,
            }}
          >
            {t("jobs")}
          </Typography>
          {data.activeJobs.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {t("noRecentJobs")}
            </Typography>
          ) : (
            <Stack
              sx={{
                gap: 0.5,
              }}
            >
              {data.activeJobs.map((job) => (
                <Stack
                  key={`${job.source}:${job.id}`}
                  direction="row"
                  sx={{
                    alignItems: "center",
                    gap: 1,
                    py: 0.5,
                    borderBottom: "1px solid",
                    borderColor: "divider",
                  }}
                >
                  <Chip
                    label={tShared("jobStatusLabel", { status: job.status })}
                    size="small"
                    color={jobStatusColor(job.status)}
                    variant="outlined"
                    sx={{ fontSize: 10, height: 18, minWidth: 60 }}
                  />
                  <Typography
                    component={Link}
                    href={adminJobHref({ id: job.id, source: job.source })}
                    variant="body2"
                    noWrap
                    sx={{ flex: 1 }}
                  >
                    {job.type}
                  </Typography>
                  {job.status === "running" && job.progress != null && (
                    <Tooltip title={format.percent(job.progress / 100)}>
                      <CircularProgress size={16} variant="determinate" value={job.progress} />
                    </Tooltip>
                  )}
                  <Typography
                    variant="caption"
                    sx={{
                      color: "text.secondary",
                    }}
                  >
                    {format.time(job.finishedAt ?? job.createdAt)}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          )}
          <Button component={Link} href="/admin/activity" size="small" sx={{ mt: 1 }}>
            {t("viewAllJobs")}
          </Button>
        </Grid>
      </Grid>
      <Divider />
      {/* Summary cards */}
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
          <StatCard title={t("systemHealth")} icon={<CheckCircleOutlineIcon />} href="/status">
            <Typography
              variant="h5"
              color={
                data.systemHealth.status === "pass"
                  ? "success.main"
                  : data.systemHealth.status === "degraded"
                    ? "warning.main"
                    : "error.main"
              }
              sx={{
                fontWeight: 700,
              }}
            >
              {data.systemHealth.status === "pass" ? t("ok") : data.systemHealth.unhealthyCount}
            </Typography>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {data.systemHealth.status === "pass"
                ? t("allSystemsOperationalStatus")
                : t("unhealthyCount", {
                    count: data.systemHealth.unhealthyCount,
                  })}
            </Typography>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
          <StatCard title={t("users")} icon={<GroupIcon />} href="/admin/users">
            <Typography
              variant="h5"
              sx={{
                fontWeight: 700,
              }}
            >
              {data.users.total}
            </Typography>
            <Stack
              direction="row"
              sx={{
                gap: 0.5,
                flexWrap: "wrap",
                mt: 0.5,
              }}
            >
              <Chip
                label={t("activeCount", { count: data.users.active24h })}
                size="small"
                color="success"
                variant="outlined"
              />
              {data.users.banned > 0 && (
                <Chip
                  label={t("bannedCount", { count: data.users.banned })}
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
            </Stack>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
          <StatCard title={t("integrations")} icon={<ExtensionIcon />} href="/admin/integrations">
            <Typography
              variant="h5"
              sx={{
                fontWeight: 700,
              }}
            >
              {data.integrations.total}
            </Typography>
            <Stack
              direction="row"
              sx={{
                gap: 0.5,
                flexWrap: "wrap",
                mt: 0.5,
              }}
            >
              <Chip
                label={t("enabledCount", { count: data.integrations.enabled })}
                size="small"
                color="success"
                variant="outlined"
              />
              {data.integrations.unhealthy > 0 && (
                <Chip
                  label={t("unhealthyCount", { count: data.integrations.unhealthy })}
                  size="small"
                  color="error"
                  variant="outlined"
                />
              )}
              {data.integrations.unconfigured > 0 && (
                <Chip
                  label={t("unconfiguredCount", { count: data.integrations.unconfigured })}
                  size="small"
                  color="warning"
                  variant="outlined"
                />
              )}
            </Stack>
          </StatCard>
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
          {data.services ? (
            <StatCard title={t("services")} icon={<DnsIcon />} href="/admin/system/services">
              <Typography
                variant="h5"
                sx={{
                  fontWeight: 700,
                }}
              >
                {data.services.running}
              </Typography>
              <Stack
                direction="row"
                sx={{
                  gap: 0.5,
                  flexWrap: "wrap",
                  mt: 0.5,
                }}
              >
                <Chip
                  label={t("runningCount", { count: data.services.running })}
                  size="small"
                  color="success"
                  variant="outlined"
                />
                <Chip
                  label={t("stoppedCount", { count: data.services.stopped })}
                  size="small"
                  variant="outlined"
                />
                {data.services.unhealthy > 0 && (
                  <Chip
                    label={t("unhealthyCount", { count: data.services.unhealthy })}
                    size="small"
                    color="error"
                    variant="outlined"
                  />
                )}
              </Stack>
            </StatCard>
          ) : (
            <StatCard title={t("services")} icon={<DnsIcon />} href="/status">
              <Typography
                variant="h5"
                sx={{
                  fontWeight: 700,
                  color: "text.secondary",
                }}
              >
                {t("notApplicable")}
              </Typography>
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {t("cloudDeployment")}
              </Typography>
            </StatCard>
          )}
        </Grid>

        <Grid size={{ xs: 12, sm: 6, md: 4, lg: "grow" }}>
          <StatCard title={t("credentials")} icon={<KeyIcon />} href="/admin/integrations">
            <Typography
              variant="h5"
              color={totalMissingCredentials > 0 ? "warning.main" : "success.main"}
              sx={{
                fontWeight: 700,
              }}
            >
              {totalMissingCredentials}
            </Typography>
            <Stack
              direction="row"
              sx={{
                gap: 0.5,
                flexWrap: "wrap",
                mt: 0.5,
              }}
            >
              <Chip
                label={t("integrationsCount", { count: credentials.length })}
                size="small"
                variant="outlined"
              />
              <Chip
                label={
                  totalMissingCredentials > 0
                    ? t("missingCount", { count: missingCredentialIntegrations.length })
                    : t("allConfigured")
                }
                size="small"
                color={totalMissingCredentials > 0 ? "warning" : "success"}
                variant="outlined"
              />
            </Stack>
          </StatCard>
        </Grid>
      </Grid>
    </Stack>
  );
}
