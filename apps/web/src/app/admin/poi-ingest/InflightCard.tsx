"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { PoiIngestStateSummary } from "@/lib/admin/poiIngestHooks";

function formatTime(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

export function InflightCard({ state }: { state: PoiIngestStateSummary }) {
  const inflight = state.inflight;
  return (
    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={1.5}>
        <Typography variant="subtitle1" fontWeight={700}>
          Inflight ingests
        </Typography>
        <Box sx={{ flex: 1 }} />
        {inflight.length > 0 && <CircularProgress size={16} />}
      </Stack>

      {inflight.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
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
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography variant="body2" fontFamily="monospace" sx={{ flex: 1 }}>
                  {job.sourceId}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {job.kind}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary">
                started {formatTime(job.startedAt)}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
