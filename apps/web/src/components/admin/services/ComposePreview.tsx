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
import { useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useComposePreview } from "@/hooks/useComposePreview";
import { invalidateServiceAdministration, serviceOrThrow } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

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
  const register = useServiceJobRegistration();
  const [renderIntent, setRenderIntent] = useState<{
    revisionId: string | null;
    key: string;
  } | null>(null);
  const renderOnly = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!renderIntent) throw Error("Refresh and confirm the configuration preview");
      const execution = owner;
      try {
        const result = await serviceOrThrow(
          sdk.renderAdminComposeConfiguration(
            { expectedCurrentRevisionId: renderIntent.revisionId, confirmed: true },
            { "idempotency-key": renderIntent.key },
            { client },
          ),
        );
        register({ client, apiUrl, jobId: result.jobId, effect: { kind: "compose" } });
        if (execution.active) {
          setRenderIntent(null);
          showToast(
            `Configuration generation queued (${result.jobId}); container application remains pending.`,
          );
        }
      } catch (error) {
        if (execution.active)
          showToast(
            error instanceof Error ? error.message : "Configuration generation failed",
            "error",
          );
        throw error;
      }
    },
  });

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
        if (execution.active)
          showToast("Stack started. Use guarded Apply/Update for Data Manager or agent changes.");
        return result;
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : "Compose up failed", "error");
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
      <ConfirmDialog
        open={renderIntent !== null}
        title="Generate configuration only"
        message="This commits configuration and prepared hardlinks. It does not start or restart containers. A nonempty hardlink plan requires Data Manager to already be running; otherwise generation is refused."
        confirmLabel="Generate only"
        loading={renderOnly.isPending}
        onConfirm={() => renderOnly.mutate()}
        onCancel={() => setRenderIntent(null)}
      />
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
          variant="outlined"
          disabled={
            renderOnly.isPending ||
            composeUp.isPending ||
            data?.expectedCurrentRevisionId === undefined
          }
          onClick={() => {
            if (data?.expectedCurrentRevisionId !== undefined)
              setRenderIntent({
                revisionId: data.expectedCurrentRevisionId,
                key: crypto.randomUUID(),
              });
          }}
        >
          Generate configuration
        </Button>
        <Button
          variant="contained"
          onClick={() => composeUp.mutate()}
          disabled={composeUp.isPending || renderOnly.isPending}
        >
          {composeUp.isPending ? "Starting..." : "Compose Up"}
        </Button>
      </Stack>
      <Alert severity="info" sx={{ mb: 2 }}>
        Compose Up starts the selected stack and applies ordinary services. It preserves existing
        Data Manager and operations-agent containers. Apply or update Data Manager from its service
        page; apply agent changes through Settings or System Maintenance.
      </Alert>
      <Alert severity="info" sx={{ mb: 2 }}>
        Full shutdown stops this panel and its operations agent. From the instance checkout on the
        host, run{" "}
        <Typography component="code" sx={{ userSelect: "all" }}>
          pnpm openmapx compose down
        </Typography>
        . Volumes are retained. Use individual service controls and Activity logs for routine
        administration.
        <Stack direction="row" sx={{ gap: 1, mt: 1, flexWrap: "wrap" }}>
          <Button
            size="small"
            onClick={async () => {
              try {
                if (!navigator.clipboard) throw Error("Clipboard unavailable");
                await navigator.clipboard.writeText("pnpm openmapx compose down");
                if (owner.active) showToast("Copied host shutdown command");
              } catch {
                if (owner.active) showToast("Select and copy the displayed command", "error");
              }
            }}
          >
            Copy shutdown command
          </Button>
          <Button
            component="a"
            href="https://docs.openmapx.org/install/managing-services"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
          >
            Shutdown and recovery guidance
          </Button>
          <Button component="a" href="/admin/activity" size="small">
            Open Activity
          </Button>
        </Stack>
      </Alert>
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
          {data?.yaml}
        </pre>
      </Paper>
    </Box>
  );
}
