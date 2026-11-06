"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useMemo, useState } from "react";
import { AdminTablePagination } from "@/components/admin/shared/AdminTablePagination";
import { AdminTableSurface } from "@/components/admin/shared/AdminTableSurface";
import { formatTransitAdminTimestamp } from "@/components/admin/shared/adminTimestamp";
import { type TransitStateSummary, useTransitFeeds } from "@/lib/admin/transitHooks";

const PAGE_SIZE = 50;

function statusColor(status: string): "default" | "success" | "warning" | "error" | "primary" {
  if (status === "ok" || status === "success") return "success";
  if (status === "stale" || status === "partial") return "warning";
  if (status === "error" || status === "failed") return "error";
  if (status === "running") return "primary";
  return "default";
}

function validationColor(v: string | null): "default" | "success" | "warning" | "error" {
  if (!v) return "default";
  if (v === "ok" || v === "pass" || v === "passed") return "success";
  if (v === "warning" || v === "warn") return "warning";
  if (v === "fail" || v === "failed" || v === "error") return "error";
  return "default";
}

export function FeedsTable({ state }: { state: TransitStateSummary }) {
  const [region, setRegion] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [page, setPage] = useState(0);

  const filters = useMemo(
    () => ({ region, status, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    [region, status, page],
  );

  const { data, isLoading, isError } = useTransitFeeds(filters);

  const regionOptions = useMemo(
    () => Object.keys(state.feeds.byRegion).sort(),
    [state.feeds.byRegion],
  );
  const statusOptions = useMemo(
    () => Object.keys(state.feeds.byStatus).sort(),
    [state.feeds.byStatus],
  );

  return (
    <AdminTableSurface
      title={`Feed state (${data?.total ?? 0})`}
      toolbar={
        <Stack
          direction={{ xs: "column", sm: "row" }}
          sx={{ gap: 1, alignItems: { sm: "center" } }}
        >
          <TextField
            select
            label="Region"
            value={region}
            onChange={(e) => {
              setRegion(e.target.value);
              setPage(0);
            }}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All regions</MenuItem>
            {regionOptions.map((r) => (
              <MenuItem key={r} value={r}>
                {r}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            select
            label="Status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All statuses</MenuItem>
            {statusOptions.map((s) => (
              <MenuItem key={s} value={s}>
                {s}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
      }
      pagination={
        data ? (
          <AdminTablePagination
            count={data.total}
            page={page}
            rowsPerPage={PAGE_SIZE}
            rowsPerPageOptions={[PAGE_SIZE]}
            onPageChange={(_, nextPage) => setPage(nextPage)}
            onRowsPerPageChange={() => setPage(0)}
          />
        ) : null
      }
    >
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
          Failed to load feeds.
        </Typography>
      ) : !data || data.feeds.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            p: 2,
          }}
        >
          No feeds match the current filter.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Region</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Validation</TableCell>
                <TableCell>Last fetched</TableCell>
                <TableCell>Last imported</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.feeds.map((feed) => (
                <TableRow key={feed.id} hover>
                  <TableCell>
                    <Typography
                      variant="caption"
                      sx={{
                        fontFamily: "monospace",
                      }}
                    >
                      {feed.region}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack spacing={0.25}>
                      <Typography variant="body2">{feed.name}</Typography>
                      <Typography
                        variant="caption"
                        sx={{
                          color: "text.secondary",
                          fontFamily: "monospace",
                        }}
                      >
                        {feed.id}
                      </Typography>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={feed.status}
                      color={statusColor(feed.status)}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell>
                    {feed.validationStatus ? (
                      <Tooltip title={feed.validationMessage ?? ""}>
                        <Chip
                          size="small"
                          label={feed.validationStatus}
                          color={validationColor(feed.validationStatus)}
                          variant="outlined"
                        />
                      </Tooltip>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>{formatTransitAdminTimestamp(feed.lastFetchedAt)}</TableCell>
                  <TableCell>{formatTransitAdminTimestamp(feed.lastImportedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </AdminTableSurface>
  );
}
