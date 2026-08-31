"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { formatPoiAdminTimestamp } from "@/components/admin/shared/adminTimestamp";
import type { PoiIngestStateSummary } from "@/lib/admin/poiIngestHooks";

export function InflightCard({ state }: { state: PoiIngestStateSummary }) {
  const inflight = state.inflight;
  return (
    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
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
          Inflight ingests
        </Typography>
        <Box sx={{ flex: 1 }} />
        {inflight.length > 0 && <CircularProgress size={16} />}
      </Stack>
      {inflight.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          No ingests running.
        </Typography>
      ) : (
        <Stack spacing={1.5}>
          {inflight.map((job) => (
            <Box
              key={`${job.sourceId}:${job.kind}:${job.startedAt}`}
              sx={{
                p: 1.25,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "divider",
                bgcolor: "action.hover",
              }}
            >
              <Stack
                direction="row"
                spacing={1}
                sx={{
                  alignItems: "center",
                }}
              >
                <Typography
                  variant="body2"
                  sx={{
                    fontFamily: "monospace",
                    flex: 1,
                  }}
                >
                  {job.sourceId}
                </Typography>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {job.kind}
                </Typography>
              </Stack>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                started {formatPoiAdminTimestamp(job.startedAt)}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
