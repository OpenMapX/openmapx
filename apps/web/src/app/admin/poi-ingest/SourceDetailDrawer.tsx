"use client";

import CloseIcon from "@mui/icons-material/Close";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SyncIcon from "@mui/icons-material/Sync";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
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
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import {
  type PoiSourceDetail,
  usePoiIngestSourceDetail,
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

function durationLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function ScheduleSection({ detail }: { detail: PoiSourceDetail }) {
  const entries = Object.entries(detail.source.kinds) as Array<
    [string, { cron: string } | undefined]
  >;
  const present = entries.filter(([, spec]) => spec);
  if (present.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No schedules declared.
      </Typography>
    );
  }
  return (
    <Stack spacing={0.75}>
      {present.map(([kind, spec]) => (
        <Stack key={kind} direction="row" spacing={1.5} alignItems="center">
          <Chip size="small" variant="outlined" label={kind} sx={{ minWidth: 72 }} />
          <Typography variant="body2" fontFamily="monospace">
            {spec?.cron ?? "—"}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function FeedStateSection({ detail }: { detail: PoiSourceDetail }) {
  const feedState = detail.feedState;
  if (!feedState) {
    return (
      <Typography variant="body2" color="text.secondary">
        No ingest has run yet.
      </Typography>
    );
  }
  const hashShort = feedState.lastStaticHash ? feedState.lastStaticHash.slice(0, 12) : "—";
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
          Status
        </Typography>
        <Chip
          size="small"
          variant="outlined"
          color={statusColor(feedState.status)}
          label={feedState.status}
        />
      </Stack>
      <Stack direction="row" spacing={1}>
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
          Last static ingest
        </Typography>
        <Box>
          <Typography variant="body2">{formatTime(feedState.lastStaticIngestAt)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {feedState.lastStaticRowCount === null
              ? "— rows"
              : `${feedState.lastStaticRowCount.toLocaleString()} rows`}
            {" · "}
            {feedState.lastStaticHash ? (
              <Tooltip title={feedState.lastStaticHash}>
                <Box component="span" fontFamily="monospace">
                  {hashShort}
                </Box>
              </Tooltip>
            ) : (
              "—"
            )}
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1}>
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
          Last live ingest
        </Typography>
        <Box>
          <Typography variant="body2">{formatTime(feedState.lastLiveIngestAt)}</Typography>
          <Typography variant="caption" color="text.secondary">
            {feedState.lastLiveRowCount === null
              ? "— rows"
              : `${feedState.lastLiveRowCount.toLocaleString()} rows`}
          </Typography>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary" sx={{ minWidth: 160 }}>
          Consecutive failures
        </Typography>
        <Typography variant="body2" fontWeight={feedState.consecutiveFailures > 0 ? 700 : 400}>
          {feedState.consecutiveFailures}
        </Typography>
      </Stack>
    </Stack>
  );
}

function LastErrorSection({ detail }: { detail: PoiSourceDetail }) {
  const err = detail.feedState?.lastError;
  if (!err) return null;
  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700} mb={0.75} color="error.main">
        Last error
      </Typography>
      <Alert severity="error" variant="outlined" sx={{ mb: 1 }}>
        {err.message}
      </Alert>
      {err.stack && (
        <Box
          component="details"
          sx={{
            "& summary": { cursor: "pointer", fontSize: 12, color: "text.secondary" },
          }}
        >
          <Box component="summary">Stack trace</Box>
          <Box
            component="pre"
            sx={{
              mt: 1,
              p: 1.25,
              bgcolor: "action.hover",
              borderRadius: 1,
              fontSize: 11,
              overflow: "auto",
              maxHeight: 240,
            }}
          >
            {err.stack}
          </Box>
        </Box>
      )}
    </Box>
  );
}

function RecentJobsSection({ detail }: { detail: PoiSourceDetail }) {
  if (detail.recentJobs.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No jobs recorded yet.
      </Typography>
    );
  }
  return (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Job</TableCell>
            <TableCell>Kind</TableCell>
            <TableCell>Status</TableCell>
            <TableCell>Started</TableCell>
            <TableCell>Finished</TableCell>
            <TableCell align="right">Duration</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {detail.recentJobs.map((job) => (
            <TableRow key={job.jobId} hover>
              <TableCell>
                <Tooltip title={job.jobId}>
                  <Typography variant="caption" fontFamily="monospace">
                    {job.jobId.slice(0, 8)}…
                  </Typography>
                </Tooltip>
              </TableCell>
              <TableCell>
                <Typography variant="caption">{job.kind}</Typography>
              </TableCell>
              <TableCell>
                <Chip
                  size="small"
                  variant="outlined"
                  color={statusColor(job.status)}
                  label={job.status}
                />
              </TableCell>
              <TableCell>
                <Typography variant="caption">{formatTime(job.startedAt)}</Typography>
              </TableCell>
              <TableCell>
                <Typography variant="caption">{formatTime(job.finishedAt)}</Typography>
              </TableCell>
              <TableCell align="right">
                <Typography variant="caption">{durationLabel(job.durationMs)}</Typography>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function SourceDetailDrawerBody({
  sourceId,
  onClose,
}: {
  sourceId: string;
  onClose: () => void;
}) {
  const showToast = useAdminToast();
  const { data, isLoading, isError } = usePoiIngestSourceDetail(sourceId);
  const trigger = useTriggerPoiIngest();

  const onSync = (liveOnly: boolean) => {
    trigger.mutate(
      { sourceId, liveOnly },
      {
        onSuccess: (res) =>
          showToast(
            `Ingest ${res.status ?? "queued"}${res.jobId ? ` (${res.jobId.slice(0, 8)}…)` : ""}`,
            "success",
          ),
        onError: (err) =>
          showToast(err instanceof Error ? err.message : "Failed to trigger ingest", "error"),
      },
    );
  };

  return (
    <Box sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={2}>
        <Typography variant="h6" fontWeight={700} sx={{ flex: 1 }}>
          Source detail
        </Typography>
        <IconButton size="small" onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>

      {isLoading && (
        <Box display="flex" justifyContent="center" py={4}>
          <CircularProgress size={24} />
        </Box>
      )}
      {isError && <Alert severity="error">Failed to load source detail.</Alert>}
      {data && (
        <Stack spacing={2.5}>
          <Box>
            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
              <Typography variant="h6">{data.source.name}</Typography>
              <Chip size="small" variant="outlined" label={data.source.domain} />
            </Stack>
            <Typography variant="caption" color="text.secondary" fontFamily="monospace">
              {data.source.id}
            </Typography>
          </Box>

          <Stack spacing={0.5}>
            <Typography variant="caption" color="text.secondary">
              {data.source.coverage
                ? `Coverage bbox: [${data.source.coverage.join(", ")}]`
                : "Global (no coverage bbox)"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Station ID prefix:{" "}
              <Box component="span" fontFamily="monospace">
                {data.source.stationIdPrefix}
              </Box>
            </Typography>
          </Stack>

          <Divider />

          <Box>
            <Typography variant="subtitle2" fontWeight={700} mb={1}>
              Schedule
            </Typography>
            <ScheduleSection detail={data} />
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle2" fontWeight={700} mb={1}>
              Current state
            </Typography>
            <FeedStateSection detail={data} />
          </Box>

          <LastErrorSection detail={data} />

          <Divider />

          <Box>
            <Typography variant="subtitle2" fontWeight={700} mb={1}>
              Recent jobs ({data.recentJobs.length})
            </Typography>
            <RecentJobsSection detail={data} />
          </Box>

          <Divider />

          <Box>
            <Typography variant="subtitle2" fontWeight={700} mb={1}>
              Actions
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <Button
                variant="contained"
                size="small"
                startIcon={<SyncIcon fontSize="small" />}
                onClick={() => onSync(false)}
                disabled={trigger.isPending}
              >
                Sync now
              </Button>
              {data.source.kinds.live && !data.source.kinds.bundled && (
                <Tooltip title="Live-only sync (skips static bundle)">
                  <span>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<PlayArrowIcon fontSize="small" />}
                      onClick={() => onSync(true)}
                      disabled={trigger.isPending}
                    >
                      Sync live only
                    </Button>
                  </span>
                </Tooltip>
              )}
              {data.source.kinds.bundled && data.source.kinds.live && (
                <Tooltip title="Bundled sources must use the full sync — call Sync now instead">
                  <span>
                    <Button
                      variant="outlined"
                      size="small"
                      startIcon={<PlayArrowIcon fontSize="small" />}
                      disabled
                    >
                      Sync live only
                    </Button>
                  </span>
                </Tooltip>
              )}
            </Stack>
          </Box>
        </Stack>
      )}
    </Box>
  );
}

export function SourceDetailDrawer({
  sourceId,
  onClose,
}: {
  sourceId: string | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      anchor="right"
      open={sourceId !== null}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: "100%", sm: 600 } } }}
    >
      {sourceId !== null && <SourceDetailDrawerBody sourceId={sourceId} onClose={onClose} />}
    </Drawer>
  );
}
