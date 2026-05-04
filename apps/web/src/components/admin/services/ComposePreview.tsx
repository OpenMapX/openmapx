"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useComposePreview } from "@/hooks/useComposePreview";
import { useEnv } from "@/lib/EnvProvider";
import { useAdminToast } from "../shared/AdminToast";

export function ComposePreview() {
  const { apiUrl } = useEnv();
  const queryClient = useQueryClient();
  const showToast = useAdminToast();
  const { data, isLoading, error } = useComposePreview();

  const composeUp = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/compose/up`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Compose up failed");
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      showToast("Compose up completed");
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "compose-preview"] });
    },
    onError: (err) => showToast(err instanceof Error ? err.message : "Compose up failed", "error"),
  });

  const composeDown = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/compose/down`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Compose down failed");
      return res.json() as Promise<{ ok: boolean }>;
    },
    onSuccess: () => {
      showToast("Compose down completed");
      queryClient.invalidateQueries({ queryKey: ["admin", "services"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
      queryClient.invalidateQueries({ queryKey: ["admin", "compose-preview"] });
    },
    onError: (err) =>
      showToast(err instanceof Error ? err.message : "Compose down failed", "error"),
  });

  if (isLoading) {
    return (
      <Box display="flex" justifyContent="center" py={6}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{(error as Error).message}</Alert>;
  }

  return (
    <Box>
      <Typography variant="h5" fontWeight={700} sx={{ mb: 2 }}>
        Generated docker-compose preview
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        This is the docker-compose YAML that would be written to disk for the currently enabled
        services. It is regenerated on each request.
      </Typography>
      <Stack direction="row" spacing={1} mb={2} flexWrap="wrap">
        <Button
          variant="contained"
          onClick={() => composeUp.mutate()}
          disabled={composeUp.isPending || composeDown.isPending}
        >
          {composeUp.isPending ? "Starting..." : "Compose Up"}
        </Button>
        <Button
          variant="outlined"
          color="warning"
          onClick={() => composeDown.mutate()}
          disabled={composeUp.isPending || composeDown.isPending}
        >
          {composeDown.isPending ? "Stopping..." : "Compose Down"}
        </Button>
      </Stack>
      <Paper
        variant="outlined"
        sx={(theme) => ({
          p: 2,
          maxHeight: "70vh",
          overflow: "auto",
          // grey.50 is a fixed-light hex regardless of palette mode, and
          // `theme.palette.mode` always reads "light" under our CSS-variable
          // theme (the runtime mode switches via the .dark class, not the
          // JS theme object). `applyStyles("dark", …)` is the supported way
          // to scope styles to the dark color scheme — produces a `.dark &`
          // selector that overrides the base bgcolor.
          bgcolor: "grey.50",
          color: "text.primary",
          ...theme.applyStyles("dark", {
            bgcolor: "grey.900",
          }),
        })}
      >
        <pre
          style={{
            margin: 0,
            fontSize: 12,
            fontFamily: "monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {data}
        </pre>
      </Paper>
    </Box>
  );
}
