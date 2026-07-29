"use client";

import CancelIcon from "@mui/icons-material/Cancel";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { DataManagerJobStages } from "../shared/DataManagerJobStages";
import { JobStatusChip } from "./JobStatusChip";

interface JobLog {
  id: string;
  seq: number;
  stream: string;
  line: string;
  createdAt: string;
}

interface JobDetailData {
  source: "application" | "data-manager";
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  progress: number | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelable: boolean;
  logs: JobLog[];
  stages: JobStage[];
}

interface JobStage {
  id: string;
  stage: string;
  status: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  message: string | null;
  error: unknown;
  artifacts: unknown;
}

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

  const { data, isLoading, isError } = useQuery<JobDetailData>({
    queryKey: ["admin", "jobs", source, jobId],
    queryFn: async () => {
      const params = new URLSearchParams({ source });
      const res = await fetch(`${env.apiUrl}/api/admin/jobs/${jobId}?${params}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load job");
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && isActive(status) ? 2000 : false;
    },
  });

  useEffect(() => {
    if (data && isActive(data.status)) {
      logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [data?.logs.length, data?.status, data]);

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
