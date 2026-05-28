"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Pagination from "@mui/material/Pagination";
import Paper from "@mui/material/Paper";
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
import { type TransitStateSummary, useTransitFeeds } from "@/lib/admin/transitHooks";

const PAGE_SIZE = 50;

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

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={1.5}
        sx={{
          alignItems: { sm: "center" },
          mb: 1.5,
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          Feed state ({data?.total ?? 0})
        </Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          select
          size="small"
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
          size="small"
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
          Failed to load feeds.
        </Typography>
      ) : !data || data.feeds.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          No feeds match the current filter.
        </Typography>
      ) : (
        <>
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
                    <TableCell>{formatTime(feed.lastFetchedAt)}</TableCell>
                    <TableCell>{formatTime(feed.lastImportedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {totalPages > 1 && (
            <Stack
              direction="row"
              sx={{
                justifyContent: "flex-end",
                mt: 1.5,
              }}
            >
              <Pagination
                size="small"
                count={totalPages}
                page={page + 1}
                onChange={(_, p) => setPage(p - 1)}
              />
            </Stack>
          )}
        </>
      )}
    </Paper>
  );
}
