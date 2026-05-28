"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect, useRef, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

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
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const [lines, setLines] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;

    setLines([]);
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const res = await fetch(`${apiUrl}/api/admin/services/${serviceId}/logs`, {
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          setError(`HTTP ${res.status}: ${res.statusText}`);
          setStreaming(false);
          return;
        }
        if (!res.body) {
          setError("No response body");
          setStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";

          if (parts.length > 0) {
            setLines((prev) => {
              const next = [...prev, ...parts.filter((p) => p.length > 0)];
              return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
            });
          }
        }

        if (buffer.length > 0) {
          setLines((prev) => {
            const next = [...prev, buffer];
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name !== "AbortError") {
          setError(err.message);
        }
      } finally {
        setStreaming(false);
      }
    })();

    return () => {
      controller.abort();
      abortRef.current = null;
    };
  }, [open, serviceId, apiUrl]);

  useEffect(() => {
    if (open && lines.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [lines, open]);

  function handleClose() {
    abortRef.current?.abort();
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
