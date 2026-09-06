"use client";

import CancelIcon from "@mui/icons-material/Cancel";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { DataManagerJobStages } from "../shared/DataManagerJobStages";
import { JobStatusChip } from "../shared/JobStatusChip";
import {
  type JobDetailData,
  type JobStreamConnection,
  useJobEventStream,
} from "./useJobEventStream";

const CONNECTION_LABEL: Record<JobStreamConnection, string | null> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  polling: "Polling",
  closed: null,
};

/** Poll cadence used only when the event stream is unavailable. */
const POLL_INTERVAL_MS = 5_000;

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function isActive(status: string) {
  return status === "running" || status === "queued";
}

export function JobDetail({
  jobId,
  source,
}: {
  jobId: string;
  source: "application" | "data-manager";
}) {
  const env = useEnv();
  const queryClient = useQueryClient();
  const logEndRef = useRef<HTMLDivElement>(null);

  // Application jobs stream their state; data-manager jobs are written by
  // another process and keep the query below as their only source.
  const streamUrl =
    source === "application"
      ? `${env.apiUrl}/api/admin/jobs/${encodeURIComponent(jobId)}/events?source=application`
      : null;
  const stream = useJobEventStream(streamUrl);
  const polling = stream.connection === "polling";

  const query = useQuery<JobDetailData>({
    queryKey: ["admin", "jobs", source, jobId],
    queryFn: async () => {
      const params = new URLSearchParams({ source });
      const res = await fetch(`${env.apiUrl}/api/admin/jobs/${jobId}?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load job");
      return res.json();
    },
    // While the stream is healthy the initial fetch still seeds the view
    // quickly; only the polling fallback keeps refetching afterwards.
    refetchInterval: (query) => {
      if (!polling) return false;
      const status = query.state.data?.status;
      return status && isActive(status) ? POLL_INTERVAL_MS : false;
    },
  });
  const data = stream.data ?? query.data;
  const isLoading = !data && query.isLoading;
  const isError = !data && query.isError;
  const connectionLabel = CONNECTION_LABEL[stream.connection];

  useEffect(() => {
    if (data && isActive(data.status)) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [data?.logs.length, data?.status, data]);

  useEffect(() => {
    // The list view still polls; refresh it once the stream reports an end
    // state so both surfaces agree without waiting for the next poll.
    if (stream.connection === "closed") {
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    }
  }, [stream.connection, queryClient]);

  const cancel = useMutation({
    mutationFn: async () => {
      const params = new URLSearchParams({ source });
      const res = await fetch(`${env.apiUrl}/api/admin/jobs/${jobId}/cancel?${params}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Cancel failed");
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    },
  });

  if (isError) {
    return (
      <Typography variant="body2" color="error">
        Failed to load job details.
      </Typography>
    );
  }

  if (isLoading || !data) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 2,
        }}
      >
        <CircularProgress size={20} />
      </Box>
    );
  }

  return (
    <Stack
      sx={{
        gap: 1.5,
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          gap: 1,
          flexWrap: "wrap",
        }}
      >
        <JobStatusChip status={data.status} />
        {connectionLabel && data.source === "application" && isActive(data.status) && (
          <Chip
            size="small"
            variant="outlined"
            color={stream.connection === "live" ? "success" : "default"}
            label={connectionLabel}
          />
        )}
        {data.status === "running" && (
          <Box sx={{ flexGrow: 1, maxWidth: 200 }}>
            <LinearProgress
              variant={data.progress == null ? "indeterminate" : "determinate"}
              value={data.progress ?? undefined}
            />
          </Box>
        )}
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          Duration: {formatDuration(data.startedAt, data.finishedAt)}
        </Typography>
        {data.cancelable && isActive(data.status) && (
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={<CancelIcon />}
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending}
          >
            Cancel
          </Button>
        )}
      </Stack>
      {data.error && (
        <Box
          sx={{
            bgcolor: "error.50",
            border: "1px solid",
            borderColor: "error.200",
            borderRadius: 1,
            px: 1.5,
            py: 1,
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: "error.main",
              fontFamily: "monospace",
            }}
          >
            {data.error}
          </Typography>
        </Box>
      )}
      {data.source === "data-manager" ? (
        <DataManagerJobStages
          stages={data.stages}
          emptyMessage={isActive(data.status) ? "Waiting for the first stage..." : undefined}
        />
      ) : (
        <Box
          sx={{
            bgcolor: "grey.900",
            borderRadius: 1,
            p: 1.5,
            maxHeight: 300,
            overflowY: "auto",
            fontFamily: "monospace",
            fontSize: "0.75rem",
            lineHeight: 1.6,
          }}
        >
          {data.logs.length === 0 ? (
            <Typography variant="caption" sx={{ color: "grey.500" }}>
              {isActive(data.status) ? "Waiting for output..." : "No log output"}
            </Typography>
          ) : (
            data.logs.map((log) => (
              <Box
                key={log.id}
                component="div"
                sx={{ color: log.stream === "stderr" ? "error.300" : "grey.100" }}
              >
                {log.line}
              </Box>
            ))
          )}
          <div ref={logEndRef} />
        </Box>
      )}
      {data.result && Object.keys(data.result).length > 0 && (
        <Box>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontWeight: 600,
            }}
          >
            Result
          </Typography>
          <Box
            component="pre"
            sx={(theme) => ({
              mt: 0.5,
              p: 1,
              // `grey.50` is a fixed-light hex regardless of palette mode,
              // and `theme.palette.mode` always reads "light" under our CSS-
              // variable theme. Use applyStyles("dark", …) to flip via the
              // .dark class — same fix as the compose preview block.
              bgcolor: "grey.50",
              color: "text.primary",
              ...theme.applyStyles("dark", { bgcolor: "grey.900" }),
              borderRadius: 1,
              fontSize: "0.7rem",
              overflow: "auto",
              maxHeight: 120,
            })}
          >
            {JSON.stringify(data.result, null, 2)}
          </Box>
        </Box>
      )}
    </Stack>
  );
}
