"use client";

import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import RefreshIcon from "@mui/icons-material/Refresh";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Collapse from "@mui/material/Collapse";
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
import { useState } from "react";
import { relativeTimeFromIso } from "@/lib/formatTime";
import { AdminTablePagination } from "../shared/AdminTablePagination";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { JobStatusChip } from "../shared/JobStatusChip";
import { TableSkeleton } from "../shared/TableSkeleton";
import { useServerPagination } from "../shared/tableHooks";
import { ActorCell } from "./ActorCell";
import { ACTIVITY_READ_TIMEOUT_MS, useActivityClient } from "./activityQueries";
import { JobDetail } from "./JobDetail";

type StatusFilter = "all" | "active" | "completed" | "failed";

function formatJobType(type: string): string {
  return type.replace(/[.:]/g, " › ").replace(/[_-]/g, " ");
}

function formatPayload(payload: unknown): string | null {
  if (payload == null) return null;
  if (Array.isArray(payload)) return JSON.stringify(payload);
  if (typeof payload !== "object") return String(payload);
  return Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

function JobRow({ job }: { job: AdminActivityJob }) {
  const [expanded, setExpanded] = useState(false);
  const payload = formatPayload(job.payload);

  return (
    <>
      <TableRow
        hover
        onClick={() => setExpanded((v) => !v)}
        sx={{ cursor: "pointer", "& td": { borderBottom: expanded ? "none" : undefined } }}
      >
        <TableCell sx={{ width: 32, px: 1 }}>
          <IconButton size="small" tabIndex={-1}>
            {expanded ? (
              <KeyboardArrowDownIcon fontSize="small" />
            ) : (
              <KeyboardArrowRightIcon fontSize="small" />
            )}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
            }}
          >
            {formatJobType(job.type)}
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
              Data manager
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
          <Tooltip title={new Date(job.createdAt).toLocaleString()}>
            <Typography
              variant="caption"
              sx={{
                color: "text.secondary",
              }}
            >
              {relativeTimeFromIso(job.createdAt)}
            </Typography>
          </Tooltip>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell
          colSpan={5}
          sx={(theme) => ({
            py: 0,
            px: 2,
            // `theme.palette.mode` always reads "light" with our CSS-vars
            // theme, so apply a dark-scope override instead of branching.
            bgcolor: "grey.50",
            ...theme.applyStyles("dark", { bgcolor: "grey.900" }),
          })}
        >
          <Collapse in={expanded} unmountOnExit>
            <Box
              sx={{
                py: 1.5,
              }}
            >
              <JobDetail jobId={job.id} source={job.source} />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

export function JobList() {
  const { apiUrl, client } = useActivityClient();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const { rowsPerPage, offset, setPage, paginationProps } = useServerPagination(25);

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
                setStatusFilter(v);
                setPage(0);
              }
            }}
          >
            <ToggleButton value="all">All</ToggleButton>
            <ToggleButton value="active">Active</ToggleButton>
            <ToggleButton value="completed">Completed</ToggleButton>
            <ToggleButton value="failed">Failed</ToggleButton>
          </ToggleButtonGroup>

          <Box sx={{ flexGrow: 1 }} />

          <Chip label={`${data?.total ?? 0} jobs`} size="small" variant="outlined" />

          <Tooltip title="Refresh">
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
              <TableCell>Job</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>When</TableCell>
            </TableRow>
          </TableHead>
          {isLoading ? (
            <TableSkeleton rows={5} columns={5} />
          ) : isError ? (
            <TableBody>
              <TableRow>
                <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                  <Typography variant="body2" color="error">
                    Failed to load jobs
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
                    No jobs found
                  </Typography>
                </TableCell>
              </TableRow>
            </TableBody>
          ) : (
            <TableBody>
              {data.jobs.map((job) => (
                <JobRow key={`${job.source}:${job.id}`} job={job} />
              ))}
            </TableBody>
          )}
        </Table>
      </TableContainer>
      <AdminTablePagination
        {...paginationProps}
        count={data?.total ?? 0}
        rowsPerPageOptions={[25]}
        hideSinglePage={false}
      />
    </AdminTableSurface>
  );
}
