"use client";

import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { streamAdminServiceLogs } from "@openmapx/core/api-admin-sdk";
import { useEffect, useMemo, useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { serviceOrThrow } from "@/lib/admin/serviceAdmin";

import { BoundedServiceLogBuffer } from "./service-log-buffer";

interface ServiceLogsDrawerProps {
  open: boolean;
  onClose: () => void;
  serviceId: string;
  serviceName: string;
}

export function ServiceLogsDrawer({
  open,
  onClose,
  serviceId,
  serviceName,
}: ServiceLogsDrawerProps) {
  const { client, apiUrl } = useActivityClient();
  return (
    <ServiceLogsSession
      key={JSON.stringify([apiUrl, serviceId, open])}
      open={open}
      onClose={onClose}
      serviceId={serviceId}
      serviceName={serviceName}
      client={client}
    />
  );
}

function ServiceLogsSession({
  open,
  onClose,
  serviceId,
  serviceName,
  client,
}: ServiceLogsDrawerProps & Pick<ReturnType<typeof useActivityClient>, "client">) {
  const [output, setOutput] = useState({ lines: [] as string[], truncated: false });
  const [streaming, setStreaming] = useState(open),
    [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(200),
    [follow, setFollow] = useState(true),
    [duration, setDuration] = useState(900),
    [paused, setPaused] = useState(false),
    [connection, setConnection] = useState(0);
  const lines = output.lines;
  const request = useMemo(
    () => ({ tail, follow, duration, connection, idempotencyKey: crypto.randomUUID() }),
    [tail, follow, duration, connection],
  );
  const bottomRef = useRef<HTMLDivElement>(null),
    abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open || paused) return;
    const controller = new AbortController(),
      buffer = new BoundedServiceLogBuffer();
    abortRef.current = controller;
    setOutput(buffer.snapshot());
    setError(null);
    setStreaming(true);
    void (async () => {
      try {
        await serviceOrThrow(
          streamAdminServiceLogs(
            serviceId,
            { "idempotency-key": request.idempotencyKey },
            {
              lines: request.tail,
              follow: request.follow,
              ...(request.follow ? { maxDurationSeconds: request.duration } : {}),
            },
            {
              client,
              signal: controller.signal,
              onTextChunk: (chunk) => {
                if (controller.signal.aborted) return;
                buffer.append(chunk);
                setOutput(buffer.snapshot());
              },
            },
          ),
        );
        if (!controller.signal.aborted) {
          buffer.finish();
          setOutput(buffer.snapshot());
        }
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Service request failed");
      } finally {
        if (!controller.signal.aborted) setStreaming(false);
      }
    })();
    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [open, paused, serviceId, client, request]);

  useEffect(() => {
    if (open && lines.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, open]);

  function handleClose() {
    abortRef.current?.abort();
    setOutput({ lines: [], truncated: false });
    setError(null);
    setStreaming(false);
    onClose();
  }

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={handleClose}
      slotProps={{
        paper: {
          sx: {
            width: { xs: "100vw", sm: 640, md: 720 },
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <Stack
        direction="row"
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          px: 2,
          py: 1.5,
          borderBottom: 1,
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Stack
          direction="row"
          sx={{
            alignItems: "center",
            gap: 1,
          }}
        >
          <Typography
            variant="subtitle1"
            sx={{
              fontWeight: 700,
            }}
          >
            Logs — {serviceName}
          </Typography>
          {streaming && (
            <Chip
              label={follow ? "following" : "loading snapshot"}
              size="small"
              color="success"
              variant="outlined"
              sx={{ fontSize: "0.65rem" }}
            />
          )}
          {!streaming && lines.length > 0 && (
            <Chip
              label={`${lines.length} lines`}
              size="small"
              variant="outlined"
              sx={{ fontSize: "0.65rem" }}
            />
          )}
        </Stack>
        <IconButton aria-label="Close service logs" size="small" onClick={handleClose} edge="end">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap", p: 2 }}>
        <TextField
          select
          size="small"
          label="Tail lines"
          value={tail}
          onChange={(e) => {
            setPaused(false);
            setTail(Number(e.target.value));
          }}
          sx={{ minWidth: 110 }}
        >
          {[100, 200, 500, 1000].map((lines) => (
            <MenuItem key={lines} value={lines}>
              {lines}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Log mode"
          value={follow ? "follow" : "snapshot"}
          onChange={(e) => {
            setPaused(false);
            setFollow(e.target.value === "follow");
          }}
          sx={{ minWidth: 130 }}
        >
          <MenuItem value="follow">Follow</MenuItem>
          <MenuItem value="snapshot">Snapshot</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Follow duration"
          disabled={!follow}
          value={duration}
          onChange={(e) => {
            setPaused(false);
            setDuration(Number(e.target.value));
          }}
          sx={{ minWidth: 150 }}
        >
          {[30, 60, 300, 900].map((seconds) => (
            <MenuItem key={seconds} value={seconds}>
              {seconds} seconds
            </MenuItem>
          ))}
        </TextField>
        {follow && (
          <Button
            disabled={!streaming && !paused}
            onClick={() => {
              if (paused) {
                setPaused(false);
                setConnection((value) => value + 1);
              } else {
                abortRef.current?.abort();
                setStreaming(false);
                setPaused(true);
              }
            }}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        )}
        <Button
          onClick={() => {
            setPaused(false);
            setConnection((value) => value + 1);
          }}
        >
          {follow ? "Reconnect" : "Reload snapshot"}
        </Button>
      </Stack>
      {output.truncated && (
        <Alert severity="info">
          Earlier output was discarded. Display is limited to 1000 lines and 256 KiB, including an
          incomplete line.
        </Alert>
      )}
      {!streaming && !error && (
        <Typography variant="caption" sx={{ px: 2, pb: 1 }}>
          {paused
            ? "Paused. Resume starts a fresh log read."
            : follow
              ? "Log reader ended. Reconnect for new output; this does not indicate service failure."
              : "Snapshot complete."}
        </Typography>
      )}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          bgcolor: "#0d1117",
          p: 2,
        }}
      >
        {error && (
          <Typography
            variant="body2"
            sx={{
              color: "error.light",
              fontFamily: "monospace",
              mb: 1,
            }}
          >
            Error: {error}
          </Typography>
        )}

        {lines.length === 0 && !streaming && !error && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              fontFamily: "monospace",
            }}
          >
            No log output available.
          </Typography>
        )}

        {lines.length === 0 && streaming && (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              fontFamily: "monospace",
            }}
          >
            Waiting for log output…
          </Typography>
        )}

        <Box
          component="pre"
          sx={{
            margin: 0,
            fontFamily: "monospace",
            fontSize: "0.78rem",
            lineHeight: 1.6,
            color: "#e6edf3",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {lines.join("\n")}
        </Box>

        <div ref={bottomRef} />
      </Box>
    </Drawer>
  );
}
