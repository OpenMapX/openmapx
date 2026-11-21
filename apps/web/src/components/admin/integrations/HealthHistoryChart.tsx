"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type AdminFormatters, useAdminFormat } from "@/lib/admin/adminFormat";
import { useIntegrationAdmin } from "@/lib/admin/integrationAdmin";

type HealthBucket =
  import("@openmapx/core/api-contracts").AdminIntegrationHealthHistory["timeline"][number];

type HoursWindow = 24 | 168;

/** Format a bucket timestamp for the X axis: the hour for 24h, the weekday for 7d. */
function formatBucketLabel(hour: string, hours: HoursWindow, format: AdminFormatters): string {
  const d = new Date(hour);
  if (Number.isNaN(d.getTime())) return hour;
  return hours === 24 ? format.time(d) : format.weekday(d);
}

function HealthTooltip({
  active,
  payload,
  hours,
}: {
  active?: boolean;
  payload?: Array<{ payload: HealthBucket }>;
  hours: HoursWindow;
}) {
  const t = useTranslations("adminIntegrations");
  const format = useAdminFormat();
  if (!active || !payload?.[0]) return null;
  const bucket = payload[0].payload;
  const responseTime =
    bucket.avgResponseTime != null ? format.duration(bucket.avgResponseTime) : "—";

  return (
    <Box
      sx={{
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: "6px",
        px: 1.25,
        py: 0.75,
        boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
      }}
    >
      <Typography variant="caption" sx={{ fontWeight: 600, display: "block" }}>
        {formatBucketLabel(bucket.hour, hours, format)}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        {t("uptimePercent", { percent: format.percent(bucket.uptimePercent / 100) })}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        {t("averageResponse", { responseTime })}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        {t("checksHealthyTotal", { healthy: bucket.healthy, total: bucket.total })}
      </Typography>
    </Box>
  );
}

interface HealthHistoryChartProps {
  integrationId: string;
}

export function HealthHistoryChart({ integrationId }: HealthHistoryChartProps) {
  const t = useTranslations("adminIntegrations");
  const format = useAdminFormat();
  const admin = useIntegrationAdmin();
  const [hours, setHours] = useState<HoursWindow>(24);

  const { data, isLoading, isError } = useQuery(admin.queries.healthHistory(integrationId, hours));
  const buckets = data?.timeline ?? [];

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1 }}
      >
        <Typography variant="subtitle2" sx={{ color: "text.secondary" }}>
          {t("uptimeOverTime")}
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={hours}
          onChange={(_, value: HoursWindow | null) => {
            if (value != null) setHours(value);
          }}
          aria-label={t("healthHistoryTimeWindow")}
        >
          <ToggleButton value={24} aria-label={t("last24Hours")}>
            {t("window24h")}
          </ToggleButton>
          <ToggleButton value={168} aria-label={t("last7Days")}>
            {t("window7d")}
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {isError ? (
        <Alert severity="error">{t("failedToLoadHealthHistory")}</Alert>
      ) : isLoading ? (
        <Skeleton variant="rounded" height={220} />
      ) : buckets.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>
          {t("noHealthHistoryYet")}
        </Typography>
      ) : (
        <Box sx={{ width: "100%", height: 220, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid horizontal vertical={false} strokeDasharray="3 3" stroke="#E0E0E0" />
              <XAxis
                dataKey="hour"
                tickFormatter={(value: string) => formatBucketLabel(value, hours, format)}
                tick={{ fontSize: 10, fill: "#999" }}
                axisLine={false}
                tickLine={false}
                minTickGap={24}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(value: number) => `${value}`}
                tick={{ fontSize: 10, fill: "#999" }}
                axisLine={false}
                tickLine={false}
                width={36}
                unit="%"
              />
              <Tooltip
                content={<HealthTooltip hours={hours} />}
                cursor={{ stroke: "#999", strokeDasharray: "3 3" }}
              />
              <Line
                type="monotone"
                dataKey="uptimePercent"
                stroke="var(--omx-brand, #1A73E8)"
                strokeWidth={2}
                dot={false}
                activeDot={{
                  r: 4,
                  fill: "var(--omx-brand, #1A73E8)",
                  stroke: "#fff",
                  strokeWidth: 2,
                }}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </Box>
      )}
    </Stack>
  );
}
