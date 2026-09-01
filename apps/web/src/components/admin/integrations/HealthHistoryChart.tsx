"use client";

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Stack from "@mui/material/Stack";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useQuery } from "@tanstack/react-query";
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
import { useEnv } from "@/integration-api/runtime/EnvProvider";

interface HealthBucket {
  hour: string;
  total: number;
  healthy: number;
  uptimePercent: number;
  avgResponseTime: number | null;
}

interface HealthHistoryResponse {
  integrationId: string;
  hours: number;
  timeline: HealthBucket[];
}

type HoursWindow = 24 | 168;

/** Format an ISO-ish bucket timestamp for the X axis: HH:00 for 24h, weekday for 7d. */
function formatBucketLabel(hour: string, hours: HoursWindow): string {
  const d = new Date(hour);
  if (Number.isNaN(d.getTime())) return hour;
  if (hours === 24) {
    return `${String(d.getHours()).padStart(2, "0")}:00`;
  }
  return d.toLocaleDateString(undefined, { weekday: "short" });
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
  if (!active || !payload?.[0]) return null;
  const bucket = payload[0].payload;
  const responseTime = bucket.avgResponseTime != null ? `${bucket.avgResponseTime} ms` : "—";

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
        {formatBucketLabel(bucket.hour, hours)}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        Uptime: {bucket.uptimePercent}%
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        Avg response: {responseTime}
      </Typography>
      <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
        Checks: {bucket.healthy}/{bucket.total}
      </Typography>
    </Box>
  );
}

interface HealthHistoryChartProps {
  integrationId: string;
}

export function HealthHistoryChart({ integrationId }: HealthHistoryChartProps) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const [hours, setHours] = useState<HoursWindow>(24);

  const { data, isLoading } = useQuery<HealthBucket[]>({
    queryKey: ["admin", "integrations", integrationId, "health-history", hours],
    queryFn: async () => {
      const res = await fetch(
        `${apiUrl}/api/admin/integrations/${integrationId}/health/history?hours=${hours}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load health history");
      const body: HealthHistoryResponse = await res.json();
      return body.timeline ?? [];
    },
  });

  const buckets = data ?? [];

  return (
    <Stack sx={{ gap: 1.5 }}>
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 1 }}
      >
        <Typography variant="subtitle2" sx={{ color: "text.secondary" }}>
          Uptime over time
        </Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={hours}
          onChange={(_, value: HoursWindow | null) => {
            if (value != null) setHours(value);
          }}
          aria-label="Health history time window"
        >
          <ToggleButton value={24} aria-label="Last 24 hours">
            24h
          </ToggleButton>
          <ToggleButton value={168} aria-label="Last 7 days">
            7d
          </ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {isLoading ? (
        <Skeleton variant="rounded" height={220} />
      ) : buckets.length === 0 ? (
        <Typography variant="body2" sx={{ color: "text.secondary", py: 4, textAlign: "center" }}>
          No health history yet
        </Typography>
      ) : (
        <Box sx={{ width: "100%", height: 220, minWidth: 0 }}>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={buckets} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid horizontal vertical={false} strokeDasharray="3 3" stroke="#E0E0E0" />
              <XAxis
                dataKey="hour"
                tickFormatter={(value: string) => formatBucketLabel(value, hours)}
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
