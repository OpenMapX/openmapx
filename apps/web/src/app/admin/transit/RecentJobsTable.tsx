"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useTransitJobDetail, useTransitJobs } from "@/lib/admin/transitHooks";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function jobStatusColor(status: string): "default" | "success" | "error" | "primary" | "warning" {
  if (status === "running") return "primary";
  if (status === "success") return "success";
  if (status === "failed" || status === "error") return "error";
  if (status === "partial" || status === "stale" || status === "canceled") return "warning";
  return "default";
}

function durationLabel(startedAt: string, finishedAt: string | null): string {
  if (!finishedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function JobDetailDrawer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const { data, isLoading, isError } = useTransitJobDetail(jobId);

  return (
    <Drawer
      anchor="right"
      open
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: "100%", sm: 480 } } } }}
    >
      <Box sx={{ p: 2 }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{
            alignItems: "center",
            mb: 1.5,
          }}
        >
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
              flex: 1,
            }}
          >
            Job detail
          </Typography>
          <IconButton size="small" onClick={onClose}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
            fontFamily: "monospace",
            display: "block",
            mb: 2,
          }}
        >
          {jobId}
        </Typography>

        {isLoading && (
          <Box
            sx={{
              display: "flex",
              justifyContent: "center",
              py: 4,
            }}
          >
            <CircularProgress size={24} />
          </Box>
        )}
        {isError && (
          <Typography variant="body2" color="error">
            Failed to load job detail.
          </Typography>
        )}
        {data && (
          <Stack spacing={2}>
            <Stack
              direction="row"
              spacing={2}
              useFlexGap
              sx={{
                flexWrap: "wrap",
              }}
            >
              <Chip
                size="small"
                label={data.status}
                color={jobStatusColor(data.status)}
                variant={data.status === "running" ? "filled" : "outlined"}
              />
              <Chip
                size="small"
                label={`triggered by ${data.triggeredBy ?? "—"}`}
                variant="outlined"
              />
              <Chip
                size="small"
                label={`started ${formatTime(data.startedAt)}`}
                variant="outlined"
              />
              {data.finishedAt && (
                <Chip
                  size="small"
                  label={`duration ${durationLabel(data.startedAt, data.finishedAt)}`}
                  variant="outlined"
                />
              )}
            </Stack>

            <Box>
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 700,
                  mb: 1,
                }}
              >
                Stages ({data.stages.length})
              </Typography>
              {data.stages.length === 0 ? (
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  No stage records yet.
                </Typography>
              ) : (
                <TableContainer component={Paper} variant="outlined">
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>Stage</TableCell>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Duration</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.stages.map((stage) => (
                        <TableRow key={stage.id} hover>
                          <TableCell>
                            <Stack spacing={0.25}>
                              <Typography variant="body2">{stage.stage}</Typography>
                              {stage.message && (
                                <Typography
                                  variant="caption"
                                  sx={{
                                    color: "text.secondary",
                                  }}
                                >
                                  {stage.message}
                                </Typography>
                              )}
                              {stage.error && (
                                <Typography variant="caption" color="error">
                                  {stage.error}
                                </Typography>
                              )}
                            </Stack>
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={stage.status}
                              color={jobStatusColor(stage.status)}
                              variant="outlined"
                            />
                          </TableCell>
                          <TableCell align="right">
                            {stage.durationMs > 0
                              ? `${(stage.durationMs / 1000).toFixed(1)}s`
                              : "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Box>
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}

export function RecentJobsTable() {
  const { data, isLoading, isError } = useTransitJobs(20);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
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
          Recent jobs
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          showing up to 20 most recent
        </Typography>
      </Stack>
      {isLoading ? (
        <Box
          sx={{
            display: "flex",
            justifyContent: "center",
            py: 3,
          }}
        >
          <CircularProgress size={22} />
        </Box>
      ) : isError ? (
        <Typography variant="body2" color="error">
          Failed to load jobs.
        </Typography>
      ) : data && data.jobs.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          No jobs recorded yet.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Job ID</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Finished</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Triggered by</TableCell>
                <TableCell align="right">Duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data?.jobs.map((job) => (
                <TableRow
                  key={job.id}
                  hover
                  sx={{ cursor: "pointer" }}
                  onClick={() => setOpenJobId(job.id)}
                >
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: "monospace",
                      }}
                    >
                      {job.id.slice(0, 8)}…
                    </Typography>
                  </TableCell>
                  <TableCell>{formatTime(job.startedAt)}</TableCell>
                  <TableCell>{formatTime(job.finishedAt)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={job.status}
                      color={jobStatusColor(job.status)}
                      variant={job.status === "running" ? "filled" : "outlined"}
                    />
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {job.triggeredBy ?? "—"}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    {durationLabel(job.startedAt, job.finishedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {openJobId && <JobDetailDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />}
    </Paper>
  );
}
