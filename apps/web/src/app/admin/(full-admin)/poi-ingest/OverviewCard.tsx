"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { PoiIngestStateSummary } from "@/lib/admin/poiIngestHooks";

function statusColor(key: string): "success" | "warning" | "error" | "default" {
  if (key === "active") return "success";
  if (key === "stale") return "warning";
  if (key === "failed") return "error";
  return "default";
}

export function OverviewCard({ state }: { state: PoiIngestStateSummary }) {
  const domains = Object.entries(state.byDomain).sort(([a], [b]) => a.localeCompare(b));
  const statuses = (["active", "stale", "failed", "unknown"] as const).map((key) => ({
    key,
    count: state.byStatus[key] ?? 0,
  }));

  return (
    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
      <Stack spacing={2}>
        <Box>
          <Typography
            variant="overline"
            sx={{
              color: "text.secondary",
            }}
          >
            Sources
          </Typography>
          <Typography
            variant="h4"
            sx={{
              fontWeight: 700,
            }}
          >
            {state.sourcesCount.toLocaleString()}
          </Typography>
        </Box>

        <Box>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 700,
              mb: 0.5,
            }}
          >
            By status
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            useFlexGap
            sx={{
              flexWrap: "wrap",
            }}
          >
            {statuses.map(({ key, count }) => (
              <Chip
                key={key}
                size="small"
                color={statusColor(key)}
                variant={count > 0 ? "filled" : "outlined"}
                label={`${key} · ${count}`}
              />
            ))}
          </Stack>
        </Box>

        <Box>
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 700,
              mb: 0.5,
            }}
          >
            By domain
          </Typography>
          {domains.length === 0 ? (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              No sources registered.
            </Typography>
          ) : (
            <Stack
              direction="row"
              spacing={1}
              useFlexGap
              sx={{
                flexWrap: "wrap",
              }}
            >
              {domains.map(([domain, count]) => (
                <Chip key={domain} size="small" variant="outlined" label={`${domain} · ${count}`} />
              ))}
            </Stack>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}
