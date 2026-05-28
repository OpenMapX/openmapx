"use client";

import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SyncIcon from "@mui/icons-material/Sync";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
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
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import {
  type PoiIngestStateSummary,
  type PoiSourceSummary,
  usePoiIngestSources,
  useTriggerPoiIngest,
} from "@/lib/admin/poiIngestHooks";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

function statusColor(status: string): "success" | "warning" | "error" | "default" | "primary" {
  if (status === "active" || status === "ok" || status === "success") return "success";
  if (status === "stale" || status === "warning") return "warning";
  if (status === "failed" || status === "error") return "error";
  if (status === "running") return "primary";
  return "default";
}

function kindColor(kind: string): "default" | "info" | "secondary" {
  if (kind === "live") return "info";
  if (kind === "bundled") return "secondary";
  return "default";
}

export function PoiSourceTable({
  state,
  onSelect,
}: {
  state: PoiIngestStateSummary;
  onSelect: (id: string) => void;
}) {
  const showToast = useAdminToast();
  const [domain, setDomain] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const filters = useMemo(() => ({ domain, status }), [domain, status]);
  const { data, isLoading, isError } = usePoiIngestSources(filters);
  const trigger = useTriggerPoiIngest();

  const domainOptions = useMemo(() => Object.keys(state.byDomain).sort(), [state.byDomain]);
  const statusOptions = useMemo(() => Object.keys(state.byStatus).sort(), [state.byStatus]);

  const onSync = (source: PoiSourceSummary, liveOnly: boolean) => {
    trigger.mutate(
      { sourceId: source.sourceId, liveOnly },
      {
        onSuccess: (res) =>
          showToast(
            `Ingest ${res.status ?? "queued"} for ${source.sourceId}${
              res.jobId ? ` (${res.jobId.slice(0, 8)}…)` : ""
            }`,
            "success",
          ),
        onError: (err) =>
          showToast(
            err instanceof Error ? err.message : `Failed to trigger ingest for ${source.sourceId}`,
            "error",
          ),
      },
    );
  };

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
          Sources ({data?.length ?? 0})
        </Typography>
        <Box sx={{ flex: 1 }} />
        <TextField
          select
          size="small"
          label="Domain"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="">All domains</MenuItem>
          {domainOptions.map((d) => (
            <MenuItem key={d} value={d}>
              {d}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
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
          Failed to load sources.
        </Typography>
      ) : !data || data.length === 0 ? (
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
          }}
        >
          No sources match the current filter.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Source ID</TableCell>
                <TableCell>Domain</TableCell>
                <TableCell>Kinds</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Fails</TableCell>
                <TableCell align="right">Static rows</TableCell>
                <TableCell>Static @</TableCell>
                <TableCell align="right">Live rows</TableCell>
                <TableCell>Live @</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((row) => {
                const hasLive = row.kinds.includes("live");
                const isBundled = row.kinds.includes("bundled");
                return (
                  <TableRow
                    key={row.sourceId}
                    hover
                    sx={{ cursor: "pointer" }}
                    onClick={() => onSelect(row.sourceId)}
                  >
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: "monospace",
                          }}
                        >
                          {row.sourceId}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                          }}
                        >
                          {row.name}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: "monospace",
                        }}
                      >
                        {row.domain}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        useFlexGap
                        sx={{
                          flexWrap: "wrap",
                        }}
                      >
                        {row.kinds.map((k) => (
                          <Chip
                            key={k}
                            size="small"
                            variant="outlined"
                            color={kindColor(k)}
                            label={k}
                          />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={statusColor(row.status)}
                        label={row.status}
                      />
                    </TableCell>
                    <TableCell align="right">{row.consecutiveFailures}</TableCell>
                    <TableCell align="right">
                      {row.lastStaticRowCount === null
                        ? "—"
                        : row.lastStaticRowCount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">
                        {formatTime(row.lastStaticIngestAt)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      {row.lastLiveRowCount === null ? "—" : row.lastLiveRowCount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption">{formatTime(row.lastLiveIngestAt)}</Typography>
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{
                          justifyContent: "flex-end",
                        }}
                      >
                        <Tooltip title={isBundled ? "Bundled source — full sync" : "Sync now"}>
                          <span>
                            <Button
                              size="small"
                              startIcon={<SyncIcon fontSize="small" />}
                              onClick={() => onSync(row, false)}
                              disabled={trigger.isPending}
                            >
                              Sync
                            </Button>
                          </span>
                        </Tooltip>
                        {hasLive && !isBundled && (
                          <Tooltip title="Sync live only">
                            <span>
                              <Button
                                size="small"
                                startIcon={<PlayArrowIcon fontSize="small" />}
                                onClick={() => onSync(row, true)}
                                disabled={trigger.isPending}
                              >
                                Live
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}
