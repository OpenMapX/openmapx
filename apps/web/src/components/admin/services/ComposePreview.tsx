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
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import { useComposePreview } from "@/hooks/useComposePreview";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
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
  const t = useTranslations("adminServices");
  const queryClient = useQueryClient();
  const showToast = useAdminToast();
  const [lastAcceptedJobId, setLastAcceptedJobId] = useState<string | null>(null);
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
      if (!renderIntent) throw Error(t("refreshAndConfirmTheConfiguration"));
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
        if (execution.active) setLastAcceptedJobId(result.jobId);
        if (execution.active) {
          setRenderIntent(null);
          showToast(t("configurationGenerationQueuedJobidContainer", { jobId: result.jobId }));
        }
      } catch (error) {
        if (execution.active)
          showToast(
            error instanceof Error ? error.message : t("configurationGenerationFailed"),
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
        if (!result.ok) throw new Error(t("composeUpFailed"));
        composeUpIntent.current = null;
        void invalidateServiceAdministration(queryClient, apiUrl, effect);
        if (execution.active) showToast(t("stackStartedUseGuardedApply"));
        return result;
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("composeUpFailed"), "error");
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
        title={t("generateConfigurationOnly")}
        message={t("thisCommitsConfigurationAndPrepared")}
        confirmLabel={t("generateOnly")}
        loading={renderOnly.isPending}
        onConfirm={() => renderOnly.mutate()}
        onCancel={() => setRenderIntent(null)}
      />
      <Typography
        component="h3"
        variant="subtitle1"
        sx={{
          fontWeight: 700,
          mb: 2,
        }}
      >
        {t("generatedDockerComposePreview")}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          color: "text.secondary",
          mb: 2,
        }}
      >
        {t("thisIsTheDockerCompose")}
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
          {t("generateConfiguration")}
        </Button>
        <Button
          variant="contained"
          onClick={() => composeUp.mutate()}
          disabled={composeUp.isPending || renderOnly.isPending}
        >
          {composeUp.isPending ? t("starting") : t("composeUp")}
        </Button>
      </Stack>
      <Alert severity="info" sx={{ mb: 2 }}>
        {t("composeUpStartsTheSelected")}
      </Alert>
      <Alert severity="info" sx={{ mb: 2 }}>
        {t("fullShutdownStopsThisPanel")}
        <Typography component="code" sx={{ userSelect: "all" }}>
          {t("pnpmOpenmapxComposeDown")}
        </Typography>
        {t("volumesAreRetainedUseIndividual")}
        <Stack direction="row" sx={{ gap: 1, mt: 1, flexWrap: "wrap" }}>
          <Button
            size="small"
            onClick={async () => {
              try {
                if (!navigator.clipboard) throw Error(t("clipboardUnavailable"));
                await navigator.clipboard.writeText("pnpm openmapx compose down");
                if (owner.active) showToast(t("copiedHostShutdownCommand"));
              } catch {
                if (owner.active) showToast(t("selectAndCopyTheDisplayed"), "error");
              }
            }}
          >
            {t("copyShutdownCommand")}
          </Button>
          <Button
            component="a"
            href="https://docs.openmapx.org/install/managing-services"
            target="_blank"
            rel="noopener noreferrer"
            size="small"
          >
            {t("shutdownAndRecoveryGuidance")}
          </Button>
          <Button
            component={Link}
            href={
              lastAcceptedJobId
                ? adminJobHref({ id: lastAcceptedJobId, source: "application" })
                : "/admin/activity"
            }
            size="small"
          >
            {t("openActivity")}
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
