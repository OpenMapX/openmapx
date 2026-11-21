"use client";

import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { listAdminActivityJobs, unwrapAdminResponse } from "@openmapx/core/api-admin-sdk";
import type { AdminActivityJob, AdminActivityJobsResponse } from "@openmapx/core/api-contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { parseAdminJobSelection } from "@/lib/admin/adminJobNavigation";
import { useAdminQueryState } from "@/lib/admin/useAdminQueryState";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { JobStatusChip } from "../shared/JobStatusChip";
import { useJobTypeLabel } from "../shared/jobTypeLabel";
import { TableSkeleton } from "../shared/TableSkeleton";
import { ActorCell } from "./ActorCell";
import { ACTIVITY_READ_TIMEOUT_MS, useActivityClient } from "./activityQueries";
import { JobDetail } from "./JobDetail";

type StatusFilter = "all" | "active" | "completed" | "failed";

function formatPayload(payload: unknown): string | null {
  if (payload == null) return null;
  if (Array.isArray(payload)) return JSON.stringify(payload);
  if (typeof payload !== "object") return String(payload);
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

function JobRow({ job, onSelect }: { job: AdminActivityJob; onSelect: () => void }) {
  const t = useTranslations("adminActivity");
  const jobTypeLabel = useJobTypeLabel();
  const dtf = useDateTimeFormat();
  const payload = formatPayload(job.payload);

  return (
    <>
      <TableRow hover onClick={onSelect} sx={{ cursor: "pointer" }}>
        <TableCell sx={{ width: 32, px: 1 }}>
          <IconButton
            size="small"
            aria-label={t("openJobId", { id: job.id })}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            <KeyboardArrowRightIcon fontSize="small" />
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {jobTypeLabel(job.type)}
          </Typography>
          {payload && (
            <Tooltip title={payload} placement="bottom-start">
              <Typography
                variant="caption"
                noWrap
                sx={{ color: "text.secondary", display: "block", maxWidth: 520 }}
              >
                {payload}
              </Typography>
            </Tooltip>
          )}
          {job.source === "data-manager" && (
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
              {t("dataManager")}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          <JobStatusChip status={job.status} />
        </TableCell>
        <TableCell>
          <ActorCell actorId={job.createdBy} actor={job.actor} fallbackLabel={job.actorLabel} />
        </TableCell>
        <TableCell>
          <Tooltip title={dtf.dateTime(job.createdAt)}>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {dtf.recent(job.createdAt)}
            </Typography>
          </Tooltip>
        </TableCell>
      </TableRow>
    </>
  );
}

export function JobList() {
  const t = useTranslations("adminActivity");
  const { apiUrl, client } = useActivityClient();
  const queryClient = useQueryClient();
  const { params, update } = useAdminQueryState();
  const selection = parseAdminJobSelection(params);
  const rawStatus = params.get("status");
  const statusFilter: StatusFilter =
    rawStatus === "active" || rawStatus === "completed" || rawStatus === "failed"
      ? rawStatus
      : "all";
  const rawPage = params.get("page") ?? "0";
  const page = /^\d{1,6}$/.test(rawPage) ? Math.min(100000, Number(rawPage)) : 0;
  const rowsPerPage = 25,
    offset = page * rowsPerPage;

  const { data, isLoading, isFetching, isError } = useQuery<AdminActivityJobsResponse>({
    queryKey: ["admin", "jobs", "list", apiUrl, statusFilter, rowsPerPage, offset],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(
        await listAdminActivityJobs(
          { limit: rowsPerPage, offset, status: statusFilter === "all" ? undefined : statusFilter },
          { client, signal, timeoutMs: ACTIVITY_READ_TIMEOUT_MS },
        ),
      ),
    refetchInterval: 5000,
  });

  return (
    <Stack sx={{ gap: 2 }}>
      {selection && (
        <Box
          component="section"
          aria-label={t("selectedJob")}
          sx={{
            p: 2,
            border: 1,
            borderColor: "divider",
            borderRadius: 2,
            bgcolor: "background.paper",
          }}
        >
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, flexWrap: "wrap", mb: 1 }}>
            <Typography component="h2" variant="subtitle1" sx={{ flexGrow: 1 }}>
              {t("selectedJobHeading", {
                source: selection.source.replace("-", "_"),
                id: selection.id,
              })}
            </Typography>
            {selection.returnTo && (
              <Button component={Link} href={selection.returnTo} size="small">
                {t("returnToTask")}
              </Button>
            )}
            <Button
              size="small"
              onClick={() => update({ job: null, source: null, returnTo: null })}
            >
              {t("closeJobDetails")}
            </Button>
          </Stack>
          <JobDetail
            key={`${selection.source}:${selection.id}`}
            jobId={selection.id}
            source={selection.source}
          />
        </Box>
      )}
      <AdminTableSurface
        toolbar={
          <Stack
            direction="row"
            sx={{
              alignItems: "center",
              gap: 1,
              flexWrap: "wrap",
            }}
          >
            <ToggleButtonGroup
              size="small"
              value={statusFilter}
              exclusive
              onChange={(_, v) => {
                if (v) {
                  update({ status: String(v), page: null }, "replace");
                }
              }}
            >
              <ToggleButton value="all">{t("all")}</ToggleButton>
              <ToggleButton value="active">{t("active")}</ToggleButton>
              <ToggleButton value="completed">{t("completed")}</ToggleButton>
              <ToggleButton value="failed">{t("failed")}</ToggleButton>
            </ToggleButtonGroup>

            <Box sx={{ flexGrow: 1 }} />

            <Chip
              label={t("jobCount", { count: data?.total ?? 0 })}
              size="small"
              variant="outlined"
            />

            <Tooltip title={t("refresh")}>
              <IconButton
                size="small"
                onClick={() =>
                  void queryClient.invalidateQueries({ queryKey: ["admin", "jobs", "list"] })
                }
                disabled={isFetching}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        }
      >
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 32 }} />
                <TableCell>{t("job")}</TableCell>
                <TableCell>{t("status")}</TableCell>
                <TableCell>{t("actor")}</TableCell>
                <TableCell>{t("when")}</TableCell>
              </TableRow>
            </TableHead>
            {isLoading ? (
              <TableSkeleton rows={5} columns={5} />
            ) : isError ? (
              <TableBody>
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography variant="body2" color="error">
                      {t("failedToLoadJobs")}
                    </Typography>
                  </TableCell>
                </TableRow>
              </TableBody>
            ) : !data?.jobs.length ? (
              <TableBody>
                <TableRow>
                  <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      {t("noJobsFound")}
                    </Typography>
                  </TableCell>
                </TableRow>
              </TableBody>
            ) : (
              <TableBody>
                {data.jobs.map((job) => (
                  <JobRow
                    key={`${job.source}:${job.id}`}
                    job={job}
                    onSelect={() =>
                      update({ tab: "jobs", job: job.id, source: job.source, returnTo: null })
                    }
                  />
                ))}
              </TableBody>
            )}
          </Table>
        </TableContainer>
        <AdminTablePagination
          page={page}
          rowsPerPage={rowsPerPage}
          onPageChange={(_, next) => update({ page: String(next) }, "replace")}
          onRowsPerPageChange={() => {}}
          count={data?.total ?? 0}
          rowsPerPageOptions={[25]}
          hideSinglePage={false}
        />
      </AdminTableSurface>
    </Stack>
  );
}
