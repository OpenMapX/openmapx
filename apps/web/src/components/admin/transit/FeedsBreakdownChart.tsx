"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { TransitStateSummary } from "@/lib/admin/transitHooks";

/**
 * Pure-CSS bar chart for the by-region / by-status counts. Keeps the dep
 * surface flat — recharts is already in apps/web for the analytics pages
 * but this view is tiny enough that the inline bars stay denser, and SSR
 * stays trivial.
 */

const STATUS_COLORS: Record<string, string> = {
  ok: "#16a34a",
  success: "#16a34a",
  stale: "#eab308",
  partial: "#eab308",
  warning: "#eab308",
  error: "#dc2626",
  failed: "#dc2626",
  running: "#3b82f6",
};

const MAX_REGION_BARS = 10;

function colorFor(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? "#94a3b8";
}

function Bar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: "center",
      }}
    >
      <Typography
        variant="caption"
        sx={{
          minWidth: 88,
          fontFamily: "monospace",
          color: "text.secondary",
          textOverflow: "ellipsis",
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
        title={label}
      >
        {label}
      </Typography>
      <Box sx={{ flex: 1, bgcolor: "action.hover", height: 10, borderRadius: 0.5 }}>
        <Box
          sx={{
            width: `${pct}%`,
            height: "100%",
            bgcolor: color,
            borderRadius: 0.5,
          }}
        />
      </Box>
      <Typography variant="caption" sx={{ minWidth: 32, textAlign: "right" }}>
        {value}
      </Typography>
    </Stack>
  );
}

export function FeedsBreakdownChart({ state }: { state: TransitStateSummary }) {
  const regionEntries = Object.entries(state.feeds.byRegion).sort((a, b) => b[1] - a[1]);
  const remainingRegionCount = regionEntries
    .slice(MAX_REGION_BARS)
    .reduce((sum, [, count]) => sum + count, 0);
  const visibleRegionEntries = [
    ...regionEntries.slice(0, MAX_REGION_BARS),
    ...(remainingRegionCount > 0
      ? [["Other regions", remainingRegionCount] as [string, number]]
      : []),
  ];
  const statusEntries = Object.entries(state.feeds.byStatus).sort((a, b) => b[1] - a[1]);
  const maxRegion = Math.max(0, ...regionEntries.map(([, v]) => v));
  const maxStatus = Math.max(0, ...statusEntries.map(([, v]) => v));

  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 1.5,
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          Feeds breakdown
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Chip size="small" variant="outlined" label={`${state.feedCount} total`} />
      </Stack>
      <Stack direction={{ xs: "column", md: "row" }} spacing={3}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
              mb: 1,
            }}
          >
            By region · {regionEntries.length} total
          </Typography>
          {regionEntries.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              No feeds yet.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {visibleRegionEntries.map(([region, count]) => (
                <Bar key={region} label={region} value={count} max={maxRegion} color="#6366f1" />
              ))}
            </Stack>
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
              mb: 1,
            }}
          >
            By status
          </Typography>
          {statusEntries.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              No feeds yet.
            </Typography>
          ) : (
            <Stack spacing={0.5}>
              {statusEntries.map(([status, count]) => (
                <Bar
                  key={status}
                  label={status}
                  value={count}
                  max={maxStatus}
                  color={colorFor(status)}
                />
              ))}
            </Stack>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}
