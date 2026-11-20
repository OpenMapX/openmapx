"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import MergeIcon from "@mui/icons-material/Merge";
import RefreshIcon from "@mui/icons-material/Refresh";
import SyncIcon from "@mui/icons-material/Sync";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import type { OvertureRecoveryStatus, OvertureStatus } from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { adminJobHref } from "@/lib/admin/adminJobNavigation";
import type { AdminTranslator } from "@/lib/admin/adminTranslator";
import { SERVICE_READ_TIMEOUT_MS } from "@/lib/admin/serviceAdmin";
import { useServiceJobRegistration } from "@/lib/admin/serviceAdminJobs";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import {
  type AdminOperationFormValues,
  previewAdminOperation,
  runAdminOperation,
} from "../operations/adminOperationsApi";
import { useAdminToast } from "../shared/AdminToast";
import { ConfirmDialog } from "../shared/ConfirmDialog";

type Operation =
  | "overture-sync"
  | "overture-conflate"
  | "overture-restart"
  | "overture-pull"
  | "overture-ingest"
  | "overture-extract";
function operationRequest(name: Operation, region: string) {
  return {
    id: name === "overture-restart" ? "overture-conflate" : name,
    input: {
      region,
      ...(["overture-restart", "overture-conflate"].includes(name)
        ? { restart: name === "overture-restart" }
        : {}),
    } as AdminOperationFormValues,
  };
}

export function overtureProgress(
  status:
    | Partial<
        Pick<
          OvertureStatus,
          | "status"
          | "phase"
          | "extractedCount"
          | "processedCount"
          | "componentCount"
          | "assignmentCursor"
          | "emittedCount"
          | "placeCount"
        >
      >
    | null
    | undefined,
  t: AdminTranslator,
): {
  value: number | null;
  label: string;
} | null {
  if (status?.status !== "running") return null;
  if (
    status.phase === "score" &&
    status.extractedCount &&
    status.processedCount !== null &&
    status.processedCount !== undefined
  ) {
    return {
      value: Math.min(100, (status.processedCount / status.extractedCount) * 100),
      label: t("overtureScored", {
        processed: status.processedCount.toLocaleString(),
        extracted: status.extractedCount.toLocaleString(),
      }),
    };
  }
  if (
    status.phase === "assign" &&
    status.componentCount &&
    status.assignmentCursor !== null &&
    status.assignmentCursor !== undefined
  ) {
    return {
      value: Math.min(100, (status.assignmentCursor / status.componentCount) * 100),
      label: t("overtureAssigned", {
        assigned: status.assignmentCursor.toLocaleString(),
        components: status.componentCount.toLocaleString(),
      }),
    };
  }
  const label =
    status.phase === "extract"
      ? t("overtureStreamed", { emitted: status.emittedCount?.toLocaleString() ?? "0" })
      : status.phase === "publish"
        ? t("overturePublishing")
        : t("overturePreparing");
  return { value: null, label };
}

export function canResumeOvertureLinks(
  status: Pick<OvertureStatus, "status" | "stalled"> | null | undefined,
  region: string,
  operationPending: boolean,
): boolean {
  return (
    region.trim().length > 0 &&
    !operationPending &&
    (status?.status !== "running" || status.stalled === true)
  );
}

export function overtureStatusQueryKey(apiUrl: string) {
  return ["admin", "overture", apiUrl, "status"] as const;
}

export function OvertureMaintenance({ apiUrl }: { apiUrl: string }) {
  return <OvertureMaintenanceView key={apiUrl} apiUrl={apiUrl} />;
}
function OvertureMaintenanceView({ apiUrl }: { apiUrl: string }) {
  const t = useTranslations("adminServices");
  const operationLabels: Record<Operation, string> = {
    "overture-sync": t("overtureSync"),
    "overture-conflate": t("overtureConflate"),
    "overture-restart": t("overtureRestart"),
    "overture-pull": t("overturePull"),
    "overture-ingest": t("overtureIngest"),
    "overture-extract": t("overtureExtract"),
  };
  const showToast = useAdminToast();
  const [lastAcceptedJobId, setLastAcceptedJobId] = useState<string | null>(null);
  const register = useServiceJobRegistration();
  const client = useMemo(
    () => createApiClient({ baseUrl: apiUrl, credentials: "include" }),
    [apiUrl],
  );
  const [region, setRegion] = useState("");
  const [prepared, setPrepared] = useState<{
    name: Operation;
    region: string;
    input: AdminOperationFormValues;
    preview: Awaited<ReturnType<typeof previewAdminOperation>>;
  } | null>(null);
  const confirmOperation = prepared?.name ?? null;

  const statusQuery = useQuery<OvertureStatus | null>({
    queryKey: overtureStatusQueryKey(apiUrl),
    queryFn: async ({ signal }) => {
      const response = await sdk.getApiDataManagerOvertureStatus({
        client,
        signal,
        timeoutMs: SERVICE_READ_TIMEOUT_MS,
      });
      if (response.status === 404) return null;
      return sdk.unwrapAdminResponse(response);
    },
    refetchInterval: (query) => (query.state.data?.status === "running" ? 10_000 : 60_000),
  });

  const regionValid =
    /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/.test(region.trim()) && region.trim().length <= 512;
  const recoveryQuery = useQuery<OvertureRecoveryStatus>({
    queryKey: [...overtureStatusQueryKey(apiUrl), "recovery", region.trim()],
    enabled: regionValid,
    queryFn: async ({ signal }) =>
      sdk.unwrapAdminResponse(
        await sdk.getApiDataManagerOvertureRecovery(
          { region: region.trim() },
          { client, signal, timeoutMs: SERVICE_READ_TIMEOUT_MS },
        ),
      ),
    refetchInterval: (query) => (query.state.data?.busy ? 10000 : 30000),
  });

  const owner = useAdminMutationOwner(client, JSON.stringify([region, confirmOperation]));
  const prepare = useMutation({
    retry: false,
    mutationFn: async (name: Operation) => {
      const scope = owner,
        selectedRegion = region.trim(),
        request = operationRequest(name, selectedRegion);
      try {
        const preview = await previewAdminOperation(client, request.id, request.input);
        if (scope.active)
          setPrepared({ name, region: selectedRegion, input: request.input, preview });
      } catch (error) {
        if (scope.active)
          showToast(error instanceof Error ? error.message : t("previewFailed"), "error");
      }
    },
  });
  const operation = useMutation({
    retry: false,
    mutationFn: async (operationName: Operation) => {
      const execution = owner;
      const effect = {
        kind: "operations",
        refreshKeys: [overtureStatusQueryKey(apiUrl)],
      } as const;
      try {
        if (!prepared || prepared.name !== operationName || prepared.region !== region.trim())
          throw Error(t("theOperationPreviewChangedReview"));
        const request = operationRequest(operationName, prepared.region);
        const jobId = await runAdminOperation(client, request.id, prepared.input);
        register({ client, apiUrl, jobId, effect });
        if (execution.active) setLastAcceptedJobId(jobId);
        if (execution.active) {
          showToast(t("queuedOperationnameJobid", { operationName, jobId }));
          setPrepared(null);
        }
      } catch (error) {
        if (execution.active)
          showToast(error instanceof Error ? error.message : t("operationFailed"), "error");
        throw error;
      }
    },
  });

  const status = statusQuery.data;
  const progress = overtureProgress(status, t);
  const recovery = recoveryQuery.data;
  const busy = recovery?.busy === true || (status?.status === "running" && !status.stalled);
  const pending = operation.isPending || prepare.isPending;
  const canRun = (name: Operation) =>
    regionValid &&
    !pending &&
    !busy &&
    Boolean(recovery) &&
    (name === "overture-sync" || recovery?.actions?.[name]?.allowed === true);
  const leaseReason = recovery?.busy
    ? t("anotherOvertureOperationHoldsThe")
    : status?.status === "running" && !status.stalled
      ? t("theOvertureLinkWorkerIs")
      : null;

  const visiblePhase =
    status?.status === "completed" && status.phase === "complete" ? undefined : status?.phase;

  return (
    <Paper component="section" variant="outlined" sx={{ p: 2 }}>
      <Stack direction={{ xs: "column", md: "row" }} sx={{ gap: 2, alignItems: { md: "center" } }}>
        <Box sx={{ flexGrow: 1 }}>
          <Stack direction="row" sx={{ gap: 1, alignItems: "center", mb: 0.5 }}>
            <MergeIcon color="primary" />
            <Typography component="h2" variant="h6">
              {t("overturePlaces")}
            </Typography>
            {status?.status && (
              <Chip
                label={t("statusValue", {
                  status: status.status,
                  value: visiblePhase ? ` · ${visiblePhase}` : "",
                })}
                color={status.stalled || status.status === "failed" ? "error" : "primary"}
                variant="outlined"
              />
            )}
          </Stack>
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("pullAndAtomicallyIngestThe")}
          </Typography>
        </Box>
        <Button
          startIcon={<RefreshIcon />}
          onClick={() => {
            void statusQuery.refetch();
            if (regionValid) void recoveryQuery.refetch();
          }}
        >
          {t("refresh")}
        </Button>
        <Button
          component={Link}
          href={
            lastAcceptedJobId
              ? adminJobHref({ id: lastAcceptedJobId, source: "application" })
              : "/admin/activity"
          }
          variant="text"
        >
          {t("viewJobs2")}
        </Button>
      </Stack>

      {statusQuery.isError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {sdk.adminErrorMessage(
            statusQuery.error,
            statusQuery.error instanceof Error ? statusQuery.error.message : t("statusUnavailable"),
          )}
        </Alert>
      )}
      {status === null && (
        <Alert severity="info" sx={{ mt: 1.5 }}>
          {t("overturePlacesHasNotBeen")}
        </Alert>
      )}
      {status?.lastError && (
        <Alert severity="error" sx={{ mt: 1.5 }}>
          {status.lastError}
        </Alert>
      )}
      {status?.stalled && (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          {t("theWorkerHeartbeatIsStale")}
          {status.heartbeatAgeMs
            ? t("floorMinutes", { floor: Math.floor(status.heartbeatAgeMs / 60_000) })
            : ""}
          {t("theExpiredLeaseCanBe")}
        </Alert>
      )}

      {status?.ok && (
        <Stack direction="row" sx={{ gap: 3, flexWrap: "wrap", mt: 1.5 }}>
          {[
            [t("release"), status.release ?? "—"],
            [t("region"), status.region ?? "—"],
            [t("places"), status.placeCount?.toLocaleString() ?? "—"],
            [t("linked"), status.linkedCount?.toLocaleString() ?? "—"],
            [t("attempts"), String(status.attemptCount ?? "—")],
          ].map(([label, value]) => (
            <Box key={label}>
              <Typography variant="caption" sx={{ color: "text.secondary" }}>
                {label}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {value}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}
      {progress && (
        <Box sx={{ mt: 1.5 }}>
          <LinearProgress
            variant={progress.value === null ? "indeterminate" : "determinate"}
            value={progress.value ?? undefined}
          />
          <Typography variant="caption" sx={{ color: "text.secondary" }}>
            {progress.label}
          </Typography>
        </Box>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        sx={{ gap: 1, alignItems: { sm: "center" }, mt: 2 }}
      >
        <TextField
          label={t("region")}
          placeholder={t("europeGermany")}
          value={region}
          onChange={(event) => setRegion(event.target.value)}
          sx={{ minWidth: 240 }}
        />
        <Button
          variant="contained"
          startIcon={<SyncIcon />}
          disabled={!canRun("overture-sync")}
          onClick={() => prepare.mutate("overture-sync")}
        >
          {t("fullSync")}
        </Button>
        <Button
          variant="outlined"
          startIcon={<MergeIcon />}
          disabled={
            !canRun("overture-conflate") || !canResumeOvertureLinks(status, region, pending)
          }
          onClick={() => prepare.mutate("overture-conflate")}
        >
          {t("resumeLinks")}
        </Button>
      </Stack>

      {leaseReason && (
        <Alert severity="info" sx={{ mt: 1 }}>
          {leaseReason}
        </Alert>
      )}
      {regionValid && recoveryQuery.isError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {t("prerequisiteInspectionIsUnavailableRestore")}
        </Alert>
      )}
      <Button
        sx={{ mt: 1 }}
        color="warning"
        variant="outlined"
        disabled={!canRun("overture-restart")}
        onClick={() => prepare.mutate("overture-restart")}
      >
        {t("restartLinksFromScratch")}
      </Button>
      {regionValid && !busy && recovery?.actions?.["overture-conflate"]?.reason && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {recovery.actions["overture-conflate"].reason}
        </Typography>
      )}
      <Accordion sx={{ mt: 2 }}>
        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
          <Typography>{t("advancedRecovery")}</Typography>
        </AccordionSummary>
        <AccordionDetails>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {t("runAnIndividualRecoveryStep")}
          </Typography>
          {recovery && (
            <Typography variant="body2" sx={{ mb: 1 }}>
              {t("completedLocalPartition")}
              {recovery.downloadedRelease ?? t("releaseNone")} {t("osmPbf")}
              {recovery.osmAvailable ? t("osmAvailable") : t("osmMissing")} {t("installedRelease")}
              {recovery.installedRelease ?? t("releaseNone")}
            </Typography>
          )}
          <Stack spacing={1}>
            {(["overture-pull", "overture-ingest", "overture-extract"] as const).map((name) => (
              <Box key={name}>
                <Button
                  variant="outlined"
                  disabled={!canRun(name)}
                  onClick={() => prepare.mutate(name)}
                >
                  {operationLabels[name]}
                </Button>
                {!busy && recovery?.actions?.[name]?.reason && (
                  <Typography variant="caption" sx={{ display: "block" }}>
                    {recovery.actions[name].reason}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        </AccordionDetails>
      </Accordion>

      <ConfirmDialog
        open={prepared !== null && prepared.region === region.trim()}
        title={
          prepared?.preview.confirmation?.title ??
          (confirmOperation ? operationLabels[confirmOperation] : t("reviewOvertureOperation"))
        }
        message={[prepared?.preview.confirmation?.message, ...(prepared?.preview.preview ?? [])]
          .filter(Boolean)
          .join(" · ")}
        confirmLabel={
          confirmOperation === "overture-restart"
            ? t("restartLinks")
            : confirmOperation === "overture-conflate"
              ? t("resume")
              : t("runOperation")
        }
        confirmColor={prepared?.preview.risk === "destructive" ? "warning" : "primary"}
        loading={operation.isPending}
        onCancel={() => setPrepared(null)}
        onConfirm={() => {
          if (confirmOperation) operation.mutate(confirmOperation);
        }}
      />
    </Paper>
  );
}
