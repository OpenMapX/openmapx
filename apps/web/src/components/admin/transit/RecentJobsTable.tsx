"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AdminJobLink } from "@/components/admin/activity/AdminJobLink";
import { AdminTableSurface } from "@/components/admin/shared/AdminTableSurface";
import { DataManagerJobStages } from "@/components/admin/shared/DataManagerJobStages";
import { JobStatusChip } from "@/components/admin/shared/JobStatusChip";
import { type AdminFormatters, useAdminFormat } from "@/lib/admin/adminFormat";
import { useTransitJobDetail, useTransitJobs } from "@/lib/admin/transitHooks";

function durationLabel(
  startedAt: string,
  finishedAt: string | null,
  format: AdminFormatters,
): string {
  if (!finishedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "—";
  return format.duration(Math.max(0, Math.round((end - start) / 1000) * 1000));
}

function JobDetailDrawer({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const t = useTranslations("adminTransit");
  const format = useAdminFormat();
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
            {t("jobDetail")}
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
          <AdminJobLink id={jobId} source="data-manager" />
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
            {t("failedToLoadJobDetail")}
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
              <JobStatusChip status={data.status} />
              <Chip
                size="small"
                label={t("triggeredByActor", {
                  actor: t("jobTrigger", { trigger: data.trigger }),
                })}
                variant="outlined"
              />
              <Chip
                size="small"
                label={t("startedAt", {
                  startedAt: format.timestamp(data.startedAt),
                })}
                variant="outlined"
              />
              {data.finishedAt && (
                <Chip
                  size="small"
                  label={t("durationValue", {
                    duration: durationLabel(data.startedAt, data.finishedAt, format),
                  })}
                  variant="outlined"
                />
              )}
            </Stack>

            <DataManagerJobStages stages={data.stages} emptyMessage={t("noStageRecordsYet")} />
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}

export function RecentJobsTable() {
  const t = useTranslations("adminTransit");
  const format = useAdminFormat();
  const { data, isLoading, isError } = useTransitJobs(20);
  const [openJobId, setOpenJobId] = useState<string | null>(null);

  return (
    <AdminTableSurface title={t("recentJobs")} description={t("showingUpTo20Most")}>
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
        <Typography variant="body2" color="error" sx={{ p: 2 }}>
          {t("failedToLoadJobs")}
        </Typography>
      ) : data && data.jobs.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            p: 2,
          }}
        >
          {t("noJobsRecordedYet")}
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t("jobId")}</TableCell>
                <TableCell>{t("started")}</TableCell>
                <TableCell>{t("finished")}</TableCell>
                <TableCell>{t("status")}</TableCell>
                <TableCell>{t("triggeredBy")}</TableCell>
                <TableCell align="right">{t("duration")}</TableCell>
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
                  <TableCell>{format.timestamp(job.startedAt)}</TableCell>
                  <TableCell>{format.timestamp(job.finishedAt)}</TableCell>
                  <TableCell>
                    <JobStatusChip status={job.status} />
                  </TableCell>
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("jobTrigger", { trigger: job.trigger })}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    {durationLabel(job.startedAt, job.finishedAt, format)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {openJobId && <JobDetailDrawer jobId={openJobId} onClose={() => setOpenJobId(null)} />}
    </AdminTableSurface>
  );
}
