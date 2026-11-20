"use client";

import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CopyIcon from "@mui/icons-material/ContentCopy";
import DiagnosticsIcon from "@mui/icons-material/MonitorHeart";
import RefreshIcon from "@mui/icons-material/Refresh";
import UpdateIcon from "@mui/icons-material/SystemUpdateAlt";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { isApiClientError } from "@openmapx/core";
import {
  ApiContractError,
  applyAdminSystemUpdate,
  checkAdminSystemUpdates,
  clearAdminReleaseSelection,
  getAdminSystemStatus,
  runAdminSystemDiagnostics,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  ADMIN_SYSTEM_UPDATE_CONFIRMATION,
  type AdminSystemImage,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { createContext, type PropsWithChildren, useContext, useEffect, useState } from "react";
import { AdminJobLink } from "@/components/admin/activity/AdminJobLink";
import Dialog from "@/components/ui/Dialog";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useAdminDraftAuthority } from "@/lib/admin/AdminDraftProvider";
import { useAdminObservedJobs, useOptionalAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import {
  AdminDisplayError,
  AdminRequestError,
  adminErrorText,
} from "@/lib/admin/adminRequestError";
import { serviceOrThrow } from "@/lib/admin/serviceAdmin";
import {
  activityJobQueryOptions,
  hasUnresolvedJobObservation,
  useActivityClient,
} from "../activity/activityQueries";
import { AdminPageHeader } from "../shared/AdminPageHeader";
import { AdminTableSurface } from "../shared/AdminTableSurface";
import { useAdminToast } from "../shared/AdminToast";
import { ErrorState } from "../shared/ErrorState";

const CONFIRMATION = ADMIN_SYSTEM_UPDATE_CONFIRMATION;
/** Typed in English on purpose: a fixed phrase, like a command, in every language. */
const CLEAR_PIN_CONFIRMATION = "CLEAR RELEASE PIN";
const HOST_UPDATE_COMMANDS = [
  "pnpm openmapx compose release --check",
  "pnpm openmapx system update --release-id RELEASE_ID --digest MANIFEST_SHA256 --session-file SESSION_FILE --receipt RECEIPT_FILE",
].join("\n");

type ImageStatus = AdminSystemImage;

interface TrackedJob {
  path: string;
  expectedDigest?: string;
  id: string;
  label: string;
}

type SubmissionPath = "updates/check" | "updates/apply" | "diagnostics";
const SUBMISSION_PATHS: SubmissionPath[] = ["updates/check", "updates/apply", "diagnostics"];

/**
 * A submission the API refused before any job existed; nothing is tracked or polled for it.
 * `until` is the server-declared retry deadline (epoch ms) while that action must wait.
 */
interface SubmissionRejection {
  path: SubmissionPath;
  label: string;
  status: number | null;
  /** A 409 that names the active job, as opposed to other conflicts such as unavailable host control. */
  busy: boolean;
  message: string;
  retrySeconds: number | null;
  until: number | null;
}

const MAX_RETRY_SECONDS = 3_600;

class SubmissionError extends AdminRequestError {
  constructor(
    detail: string | null,
    readonly status: number | null,
    readonly retrySeconds: number | null,
    readonly busy: boolean,
  ) {
    super(detail);
  }
}

function boundedSeconds(seconds: number): number | null {
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_RETRY_SECONDS
    ? Math.ceil(seconds)
    : null;
}

/** What the reader can do about a refused submission, as the `rejection` message's select code. */
function rejectionHint(
  rejection: SubmissionRejection,
  waiting: boolean,
): "wait" | "retry" | "busy" | "host" {
  if (waiting && rejection.retrySeconds) return "wait";
  if (rejection.status !== 409) return "retry";
  return rejection.busy ? "busy" : "host";
}

type SystemUpdateInput = Parameters<typeof applyAdminSystemUpdate>[0];

function requiredUpdateInput(body: SystemUpdateInput | undefined): SystemUpdateInput {
  if (!body) throw new Error("Check a release before updating");
  return body;
}

/** A refused admission keeps the server's reason, its declared wait and whether a job is active. */
function submissionError(error: unknown): unknown {
  if (!isApiClientError(error) && !(error instanceof ApiContractError)) return error;
  const payload = isApiClientError(error)
    ? (error.payload as { error?: unknown; jobId?: unknown } | null)
    : null;
  const retryAfter = isApiClientError(error) ? error.retryAfterSeconds : null;
  return new SubmissionError(
    typeof payload?.error === "string" ? payload.error : null,
    error.status,
    error.status === 429 && retryAfter !== null ? boundedSeconds(retryAfter) : null,
    error.status === 409 && typeof payload?.jobId === "string",
  );
}

function digest(value: string | null): string {
  if (!value) return "—";
  return value.replace(/^sha256:/, "").slice(0, 12);
}

function ImageStatusChip({ image }: { image: ImageStatus }) {
  const t = useTranslations("adminSystem.maintenance");
  const label = t("imageStatus", { status: image.status.replaceAll("-", "_") });
  if (image.status === "update-available") return <Chip color="warning" label={label} />;
  if (image.status === "up-to-date")
    return <Chip color="success" variant="outlined" label={label} />;
  if (image.status === "not-running") return <Chip label={label} />;
  return <Chip color="warning" variant="outlined" label={label} />;
}

function useMaintenanceState() {
  const [trackedJob, setTrackedJob] = useState<TrackedJob | null>(null);
  const [blockedCandidate, setBlockedCandidate] = useState<string | null>(null);
  const [rejections, setRejections] = useState<
    Partial<Record<SubmissionPath, SubmissionRejection>>
  >({});
  const [pending, setPending] = useState(0);
  return {
    trackedJob,
    setTrackedJob,
    blockedCandidate,
    setBlockedCandidate,
    rejections,
    setRejections,
    pending,
    setPending,
  };
}
const MaintenanceContext = createContext<ReturnType<typeof useMaintenanceState> | null>(null);
function MaintenanceStateProvider({ children }: PropsWithChildren) {
  const state = useMaintenanceState();
  return <MaintenanceContext.Provider value={state}>{children}</MaintenanceContext.Provider>;
}
export function SystemMaintenanceProvider({ children }: PropsWithChildren) {
  const { apiUrl } = useEnv();
  const { generation } = useAdminDraftAuthority();
  return (
    <MaintenanceStateProvider key={`${apiUrl}:${generation}`}>{children}</MaintenanceStateProvider>
  );
}
export function SystemMaintenance({
  section,
  showHeader = true,
}: {
  section?: "updates" | "diagnostics";
  showHeader?: boolean;
} = {}) {
  const t = useTranslations("adminSystem.maintenance");
  const tShared = useTranslations("adminShared");
  const tCommon = useTranslations("common");
  const { apiUrl, client } = useActivityClient();
  const queryClient = useQueryClient();
  const register = useOptionalAdminJobRegistration();
  const showToast = useAdminToast();
  /** ICU select keys cannot hold slashes, so `updates/check` is selected as `updates_check`. */
  const jobLabel = (path: SubmissionPath | "release/clear") =>
    t("jobLabel", { path: path.replace("/", "_") });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [candidateToApply, setCandidateToApply] = useState<{
    releaseId: string;
    expectedDigest: string;
  } | null>(null);
  const [pinToClear, setPinToClear] = useState<{
    releaseId: string;
    key: string;
    origin: string;
  } | null>(null);
  const [clearConfirmation, setClearConfirmation] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [createBackup, setCreateBackup] = useState(true);
  const local = useMaintenanceState();
  const shared = useContext(MaintenanceContext) ?? local;
  const {
    setTrackedJob,
    blockedCandidate,
    setBlockedCandidate,
    rejections,
    setRejections,
    pending,
    setPending,
  } = shared;
  const observed = useAdminObservedJobs();
  const accepted = observed.find((job) => !job.settled && job.kind?.startsWith("maintenance:"));
  const trackedJob =
    shared.trackedJob ??
    (accepted
      ? {
          id: accepted.jobId,
          label: accepted.label,
          path: accepted.kind?.slice("maintenance:".length) ?? "",
        }
      : null);

  useEffect(() => {
    const timers = SUBMISSION_PATHS.flatMap((path) => {
      const until = rejections[path]?.until;
      if (!until) return [];
      return setTimeout(
        () =>
          setRejections((current) => {
            const entry = current[path];
            return entry?.until === until
              ? { ...current, [path]: { ...entry, until: null } }
              : current;
          }),
        Math.max(0, until - Date.now()),
      );
    });
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [rejections, setRejections]);

  const statusQuery = useQuery({
    queryKey: ["admin", "system", apiUrl],
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(await getAdminSystemStatus({ client, signal })),
    refetchInterval: trackedJob ? 5_000 : false,
  });

  const jobQuery = useQuery({
    ...activityJobQueryOptions(client, apiUrl, trackedJob?.id, "application"),
    refetchInterval: trackedJob ? 3_000 : false,
    retry: true,
  });

  useEffect(() => {
    const job = jobQuery.data;
    if (
      !trackedJob ||
      !job ||
      !["success", "failed", "canceled"].includes(job.status) ||
      hasUnresolvedJobObservation(job.result)
    )
      return;
    if (
      job.result &&
      typeof job.result === "object" &&
      !Array.isArray(job.result) &&
      job.result.errorCode === "host_update_required"
    ) {
      setBlockedCandidate(trackedJob.expectedDigest ?? candidateToApply?.expectedDigest ?? null);
    }
    if (job.status === "success") {
      if (trackedJob.path === "updates/check") setBlockedCandidate(null);
      showToast(t("jobCompleted", { label: trackedJob.label }));
    } else
      showToast(
        job.error ||
          t("jobEnded", {
            label: trackedJob.label,
            statusLabel: tShared("jobStatusLabel", { status: job.status }),
          }),
        "error",
      );
    void queryClient.invalidateQueries({ queryKey: ["admin", "system"] });
    void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] });
    setTrackedJob(null);
  }, [
    candidateToApply,
    jobQuery.data,
    queryClient,
    showToast,
    t,
    tShared,
    trackedJob,
    setBlockedCandidate,
    setTrackedJob,
  ]);

  const queueJob = useMutation({
    // Maintenance actions are never repeated automatically, whatever the client defaults are.
    retry: false,
    mutationFn: async ({
      path,
      body,
      label,
    }: {
      path: SubmissionPath;
      body?: SystemUpdateInput;
      label: string;
    }) => {
      let result: { jobId: string };
      try {
        result = unwrapAdminResponse(
          path === "updates/check"
            ? await checkAdminSystemUpdates(undefined, { client })
            : path === "diagnostics"
              ? await runAdminSystemDiagnostics(undefined, { client })
              : await applyAdminSystemUpdate(requiredUpdateInput(body), { client }),
        );
      } catch (error) {
        throw submissionError(error);
      }
      register?.({
        client,
        apiUrl,
        jobId: result.jobId,
        label,
        kind: `maintenance:${path}`,
        returnTo: path === "diagnostics" ? "/admin/system/diagnostics" : "/admin/system/updates",
        onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "system", apiUrl] }),
      });
      const job = { id: result.jobId, label, path, expectedDigest: body?.expectedDigest };
      setTrackedJob(job);
      return job;
    },
    onSettled: () => setPending((count) => Math.max(0, count - 1)),
    onMutate: ({ path }) => {
      setPending((count) => count + 1);
      setRejections((current) => {
        const { [path]: _cleared, ...others } = current;
        return others;
      });
    },
    onSuccess: (job) => {
      setTrackedJob(job);
      if (job.path === "updates/apply") {
        setDialogOpen(false);
        setConfirmation("");
      }
      showToast(t("jobQueued", { label: job.label }));
    },
    onError: (error, { path, label }) => {
      const submission = error instanceof SubmissionError ? error : null;
      const message = adminErrorText(
        error,
        submission?.status === 429 ? t("tooManyRequests") : t("queueFailed", { label }),
      );
      const retrySeconds = submission?.retrySeconds ?? null;
      setRejections((current) => ({
        ...current,
        [path]: {
          path,
          label,
          status: submission?.status ?? null,
          busy: submission?.busy ?? false,
          message,
          retrySeconds,
          until: retrySeconds ? Date.now() + retrySeconds * 1000 : null,
        },
      }));
      showToast(message, "error");
    },
  });

  const clearPin = useMutation({
    onMutate: () => setPending((count) => count + 1),
    onSettled: () => setPending((count) => Math.max(0, count - 1)),
    mutationFn: async (fixed: NonNullable<typeof pinToClear>) => {
      if (fixed.origin !== apiUrl) throw new AdminDisplayError(t("originChanged"));
      const result = await serviceOrThrow(
        clearAdminReleaseSelection(
          { expectedReleaseId: fixed.releaseId, confirmation: CLEAR_PIN_CONFIRMATION },
          { "idempotency-key": fixed.key },
          { client },
        ),
      );
      register?.({
        client,
        apiUrl,
        jobId: result.jobId,
        label: jobLabel("release/clear"),
        kind: "maintenance:release/clear",
        returnTo: "/admin/system/updates",
        onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "system", apiUrl] }),
      });
      const job = { id: result.jobId, label: jobLabel("release/clear"), path: "release/clear" };
      setTrackedJob(job);
      return job;
    },
    onSuccess: (job) => {
      setTrackedJob(job);
      setPinToClear(null);
      setClearConfirmation("");
      showToast(t("jobQueued", { label: job.label }));
    },
    onError: (error) => showToast(adminErrorText(error, t("clearPinFailed")), "error"),
  });
  const status = statusQuery.data;
  const active = Boolean(trackedJob || pending || queueJob.isPending || clearPin.isPending);
  const waiting = (path: SubmissionPath) => Boolean(rejections[path]?.until);
  const rejectionAlert = (rejection: SubmissionRejection) => (
    <Alert key={rejection.path} severity="warning" sx={{ minWidth: 0 }}>
      <AlertTitle>{t("notQueued", { label: rejection.label })}</AlertTitle>
      {t("rejection", {
        message: rejection.message.replace(/[.\s]+$/, ""),
        hint: rejectionHint(rejection, waiting(rejection.path)),
        seconds: rejection.retrySeconds ?? 0,
      })}
    </Alert>
  );
  const rejectionInDialog = dialogOpen && Boolean(rejections["updates/apply"]);
  const pageRejections = SUBMISSION_PATHS.flatMap((path) => {
    const rejection = rejections[path];
    return rejection && !(path === "updates/apply" && rejectionInDialog) ? [rejection] : [];
  });
  const progress = jobQuery.data?.progress ?? 0;
  const trackedStatus = jobQuery.data?.status ?? "queued";
  const updateCount = status?.images.filter((image) => image.updateAvailable).length ?? 0;
  const checkedCandidate =
    status?.release?.availableReleaseId && status.release.availableDigest
      ? {
          releaseId: status.release.availableReleaseId,
          expectedDigest: status.release.availableDigest,
        }
      : null;
  // The agent status includes the backup helper pin check, even when its image is current.
  // An outdated agent is replaced by the update itself; an unverifiable agent, or
  // a replacement that failed for this release, still needs the host.
  const agent = status?.images.find((image) => image.id === "ops-agent");
  const agentReplacementFailed = Boolean(
    checkedCandidate && blockedCandidate === checkedCandidate.expectedDigest,
  );
  const hostUpdateRequired = Boolean(
    checkedCandidate &&
      (agentReplacementFailed ||
        (agent?.status !== "up-to-date" && agent?.status !== "update-available")),
  );
  const replacesAgent = Boolean(
    checkedCandidate && !hostUpdateRequired && agent?.status === "update-available",
  );
  const canUpdate = Boolean(
    checkedCandidate &&
      !hostUpdateRequired &&
      (updateCount > 0 ||
        status?.release?.availableReleaseId !== status?.release?.currentReleaseId),
  );

  if (statusQuery.isError) {
    return <ErrorState message={t("loadFailed")} onRetry={() => statusQuery.refetch()} />;
  }

  return (
    <Stack sx={{ gap: 2 }}>
      {showHeader && (
        <AdminPageHeader
          title={section ? t("sectionTitle", { section }) : t("title")}
          subtitle={t("subtitle")}
          actions={
            <Button component={Link} href="/admin/activity" variant="outlined">
              {t("viewActivity")}
            </Button>
          }
        />
      )}

      {status && !status.deployment.maintenanceReady && (
        <Alert severity="warning" sx={{ minWidth: 0 }}>
          <AlertTitle>{t("hostUnavailableTitle")}</AlertTitle>
          <Typography variant="body2">{t("hostUnavailable")}</Typography>
          {!hostUpdateRequired && section !== "diagnostics" && (
            <>
              <Typography variant="body2">{t("hostCliHint")}</Typography>
              <Box
                component="pre"
                sx={{
                  whiteSpace: "pre",
                  overflowX: "auto",
                  maxWidth: "100%",
                  fontSize: "0.8125rem",
                  my: 1.5,
                }}
              >
                {HOST_UPDATE_COMMANDS}
              </Box>
              <Button
                size="small"
                startIcon={<CopyIcon />}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(HOST_UPDATE_COMMANDS);
                    showToast(t("commandsCopied"));
                  } catch {
                    showToast(t("commandsCopyFailed"), "error");
                  }
                }}
              >
                {t("copyCommands")}
              </Button>
            </>
          )}
        </Alert>
      )}

      {section !== "diagnostics" && (
        <>
          <Paper variant="outlined" sx={{ p: 2, overflowWrap: "anywhere" }}>
            <Typography variant="subtitle1">{t("releaseSelection")}</Typography>
            <Typography variant="body2">
              {status?.release?.configuredSelector === undefined
                ? t("configuredChannelUnknown")
                : t("configuredChannel", { channel: status.release.configuredSelector })}
            </Typography>
            {/* Only an answered inspection names the channel; without one, a missing pin is unknown. */}
            <Typography variant="body2">
              {status?.release?.configuredSelector === undefined
                ? t("currentReleaseUnknown")
                : status.release.currentReleaseId
                  ? t("currentRelease", { release: status.release.currentReleaseId })
                  : t("currentReleaseNone")}
            </Typography>
            <Typography variant="body2">
              {status?.release?.configuredSelector === undefined
                ? t("checkedReleaseUnknown")
                : status.release.availableReleaseId
                  ? t("checkedRelease", { release: status.release.availableReleaseId })
                  : t("checkedReleaseNone")}
            </Typography>
            {status?.release?.availableDigest && (
              <Typography variant="caption" sx={{ display: "block", color: "text.secondary" }}>
                {t("manifest", { digest: status.release.availableDigest })}
              </Typography>
            )}
            <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
              {t("releaseSelectionHelp")}
            </Typography>
            <Button
              disabled={active || !status?.release?.currentReleaseId}
              onClick={() => {
                const releaseId = status?.release?.currentReleaseId;
                if (releaseId) {
                  setPinToClear({ releaseId, key: crypto.randomUUID(), origin: apiUrl });
                  setClearConfirmation("");
                }
              }}
            >
              {t("clearPin")}
            </Button>
          </Paper>

          {hostUpdateRequired && (
            <Alert severity="warning" sx={{ minWidth: 0 }}>
              <AlertTitle>{t("hostUpdateRequiredTitle")}</AlertTitle>
              <Typography variant="body2">
                {t("hostUpdateRequired", {
                  cause: String(agentReplacementFailed),
                })}
              </Typography>
              <Button component={Link} href="/admin/activity" size="small">
                {t("inspectActivity")}
              </Button>
              <Button component={Link} href="/admin/system/diagnostics" size="small">
                {t("hostDiagnostics")}
              </Button>
              <Button
                component="a"
                href="https://docs.openmapx.org/install/upgrading/"
                size="small"
              >
                {t("hostRecoveryGuide")}
              </Button>
            </Alert>
          )}

          {replacesAgent && <Alert severity="info">{t("replacesAgent")}</Alert>}
        </>
      )}

      {pageRejections.map(rejectionAlert)}

      {trackedJob && (
        <Paper variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" sx={{ alignItems: "center", gap: 1, mb: 1 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, flexGrow: 1 }}>
              {trackedJob.label}
              <AdminJobLink id={trackedJob.id} source="application" />
            </Typography>
            <Chip
              label={tShared("jobStatusLabel", { status: trackedStatus })}
              color="primary"
              variant="outlined"
            />
          </Stack>
          <LinearProgress
            variant={progress > 0 ? "determinate" : "indeterminate"}
            value={progress}
          />
        </Paper>
      )}

      {section !== "diagnostics" && (
        <AdminTableSurface
          title={t("applicationTitle")}
          description={t("applicationDescription")}
          toolbar={
            <Stack
              direction={{ xs: "column", sm: "row" }}
              sx={{ gap: 1, alignItems: { sm: "center" } }}
            >
              {updateCount > 0 && (
                <Chip color="warning" label={t("updatesAvailable", { count: updateCount })} />
              )}
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                disabled={
                  active || !status?.deployment.maintenanceReady || waiting("updates/check")
                }
                onClick={() =>
                  queueJob.mutate({ path: "updates/check", label: jobLabel("updates/check") })
                }
              >
                {t("checkForUpdates")}
              </Button>
              <Button
                variant="contained"
                startIcon={<UpdateIcon />}
                disabled={active || !status?.deployment.maintenanceReady || !canUpdate}
                title={
                  hostUpdateRequired
                    ? t("requiresHostUpdate")
                    : !canUpdate
                      ? t("checkBeforeUpdating")
                      : undefined
                }
                onClick={() => {
                  setCandidateToApply(checkedCandidate);
                  // Stale feedback goes; an active server wait keeps its explanation.
                  if (!waiting("updates/apply")) {
                    setRejections(({ "updates/apply": _stale, ...others }) => others);
                  }
                  setDialogOpen(true);
                }}
              >
                {t("updateOpenMapX")}
              </Button>
            </Stack>
          }
        >
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>{t("component")}</TableCell>
                  <TableCell>{t("image")}</TableCell>
                  <TableCell>{t("running")}</TableCell>
                  <TableCell>{t("downloaded")}</TableCell>
                  <TableCell>{t("status")}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(status?.images ?? []).map((image) => (
                  <TableRow key={image.id} hover>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {image.name}
                      </Typography>
                      <Typography variant="caption" sx={{ color: "text.secondary" }}>
                        {t("imageIdentity", { id: image.id, state: image.containerState })}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>{image.image ?? "—"}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {digest(image.runningImageId)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {digest(image.localImageId)}
                    </TableCell>
                    <TableCell>
                      <ImageStatusChip image={image} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </AdminTableSurface>
      )}

      {section !== "updates" && (
        <>
          <Paper component="section" variant="outlined" sx={{ p: 2 }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              sx={{ gap: 2, alignItems: { sm: "center" } }}
            >
              <DiagnosticsIcon color="primary" />
              <Box sx={{ flexGrow: 1 }}>
                <Typography component="h2" variant="subtitle1">
                  {t("diagnosticsTitle")}
                </Typography>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {t("diagnosticsDescription")}
                </Typography>
              </Box>
              <Button
                variant="outlined"
                startIcon={<DiagnosticsIcon />}
                disabled={active || !status?.deployment.maintenanceReady || waiting("diagnostics")}
                onClick={() =>
                  queueJob.mutate({ path: "diagnostics", label: jobLabel("diagnostics") })
                }
              >
                {t("runDiagnostics")}
              </Button>
            </Stack>
          </Paper>

          <Paper component="section" variant="outlined" sx={{ p: 2 }}>
            <Typography component="h2" variant="subtitle1" sx={{ mb: 1.5 }}>
              {t("readiness")}
            </Typography>
            <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
              {(
                [
                  ["docker", status?.deployment.dockerAvailable],
                  ["compose", status?.deployment.composeRendered],
                  ["hostControl", status?.deployment.hostControlConfigured],
                ] as const
              ).map(([check, ok]) => (
                <Chip
                  key={check}
                  icon={ok ? <CheckCircleIcon /> : undefined}
                  color={ok ? "success" : "warning"}
                  variant="outlined"
                  label={t("readinessCheck", { check })}
                />
              ))}
            </Stack>
          </Paper>
        </>
      )}

      <Dialog
        open={pinToClear !== null}
        onClose={clearPin.isPending ? undefined : () => setPinToClear(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{t("clearPinTitle")}</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 1, overflowWrap: "anywhere" }}>
            <Typography>{t("clearPinBody", { release: pinToClear?.releaseId ?? "" })}</Typography>
            <Typography>{t("clearPinPending")}</Typography>
            <TextField
              label={t("clearConfirmation")}
              value={clearConfirmation}
              onChange={(event) => setClearConfirmation(event.target.value)}
              helperText={t("typePhrase", { phrase: CLEAR_PIN_CONFIRMATION })}
              autoComplete="off"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={clearPin.isPending} onClick={() => setPinToClear(null)}>
            {tCommon("cancel")}
          </Button>
          <Button
            color="error"
            disabled={
              clearPin.isPending ||
              clearConfirmation !== CLEAR_PIN_CONFIRMATION ||
              pinToClear?.origin !== apiUrl
            }
            onClick={() => {
              if (pinToClear) clearPin.mutate(pinToClear);
            }}
          >
            {t("clearPinConfirm")}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={dialogOpen}
        onClose={active ? undefined : () => setDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>{t("updateOpenMapX")}</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 0.5 }}>
            <Typography variant="body2" sx={{ overflowWrap: "anywhere" }}>
              {t("applyRelease", {
                release: candidateToApply?.releaseId ?? "",
                digest: candidateToApply?.expectedDigest ?? "",
              })}
            </Typography>
            <Alert severity="info">{t("applyOrder")}</Alert>
            {rejections["updates/apply"] && rejectionAlert(rejections["updates/apply"])}
            <FormControlLabel
              control={
                <Checkbox
                  checked={createBackup}
                  onChange={(event) => setCreateBackup(event.target.checked)}
                />
              }
              label={t("createBackup")}
            />
            {!createBackup && <Alert severity="warning">{t("noBackupWarning")}</Alert>}
            <TextField
              autoFocus
              label={t("typeToContinue", { phrase: CONFIRMATION })}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)} disabled={queueJob.isPending}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant="contained"
            color="warning"
            startIcon={<UpdateIcon />}
            disabled={
              confirmation !== CONFIRMATION ||
              queueJob.isPending ||
              !candidateToApply ||
              hostUpdateRequired ||
              waiting("updates/apply")
            }
            onClick={() =>
              // The dialog closes only once the update is accepted (see onSuccess).
              queueJob.mutate({
                path: "updates/apply",
                body: candidateToApply
                  ? { confirmation: CONFIRMATION, createBackup, ...candidateToApply }
                  : undefined,
                label: jobLabel("updates/apply"),
              })
            }
          >
            {t("updateApplication")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
