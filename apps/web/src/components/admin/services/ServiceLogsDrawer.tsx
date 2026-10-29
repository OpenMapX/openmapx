"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { streamAdminServiceLogs } from "@openmapx/core/api-admin-sdk";
import { useEffect, useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { serviceOrThrow } from "@/lib/admin/serviceAdmin";

const MAX_LINES = 500;

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
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(open);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    abortRef.current = controller;
    let residual = "";
    function append(parts: string[]) {
      if (controller.signal.aborted) return;
      setLines((previous) =>
        [...previous, ...parts.filter((line) => line.length > 0)].slice(-MAX_LINES),
      );
    }
    void (async () => {
      try {
        await serviceOrThrow(
          streamAdminServiceLogs(serviceId, { "idempotency-key": idempotencyKey }, undefined, {
            client,
            signal: controller.signal,
            onTextChunk: (chunk) => {
              if (controller.signal.aborted) return;
              const parts = (residual + chunk).split("\n");
              residual = parts.pop() ?? "";
              append(parts);
            },
          }),
        );
        append([residual]);
      } catch (error) {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : "Service request failed");
      } finally {
        if (!controller.signal.aborted) setStreaming(false);
      }
    })();
    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [open, serviceId, client, idempotencyKey]);

  useEffect(() => {
    if (open && lines.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, open]);

  function handleClose() {
    abortRef.current?.abort();
    setLines([]);
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
              label="streaming"
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
        <IconButton size="small" onClick={handleClose} edge="end">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Stack>
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
