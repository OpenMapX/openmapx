"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useComposePreview } from "@/hooks/useComposePreview";
import { invalidateServiceAdministration, serviceOrThrow } from "@/lib/admin/serviceAdmin";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminToast } from "../shared/AdminToast";

export function ComposePreview() {
  const { client, apiUrl } = useActivityClient();
  return <ComposePreviewView key={apiUrl} client={client} apiUrl={apiUrl} />;
}

function ComposePreviewView({ client, apiUrl }: ReturnType<typeof useActivityClient>) {
  const queryClient = useQueryClient();
  const showToast = useAdminToast();
  const { data, isLoading, error } = useComposePreview();
  const owner = useAdminMutationOwner(client, apiUrl);
  const composeUpIntent = useRef<string | null>(null);

  const composeUp = useMutation({
    retry: false,
    mutationFn: async () => {
      const execution = owner;
      const effect = { kind: "compose" } as const;
      const idempotencyKey = composeUpIntent.current ?? crypto.randomUUID();
      composeUpIntent.current = idempotencyKey;
      try {
        const result = await serviceOrThrow(
          sdk.startAdminCompose({ "idempotency-key": idempotencyKey }, undefined, { client }),
        );
        if (!result.ok) throw new Error("Compose up failed");
        composeUpIntent.current = null;
        void invalidateServiceAdministration(queryClient, apiUrl, effect);
        if (execution.active) showToast("Compose up completed");
        return result;
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Compose up failed", "error");
        throw error;
      }
    },
  });
  const composeDown = useMutation({
    retry: false,
    mutationFn: async () => {
      const execution = owner;
      try {
        // This operation has no success variant: only validated host guidance/errors.
        return await serviceOrThrow(sdk.stopAdminCompose(undefined, { client }));
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Compose down failed", "error");
        throw error;
      }
    },
  });

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          justifyContent: "center",
          py: 6,
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error.message}</Alert>;
  }

  return (
    <Box>
      <Typography
        variant="h5"
        sx={{
          fontWeight: 700,
          mb: 2,
        }}
      >
        Generated docker-compose preview
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        This is the docker-compose YAML that would be written to disk for the currently enabled
        services. It is regenerated on each request.
      </Typography>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          mb: 2,
          flexWrap: "wrap",
        }}
      >
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
