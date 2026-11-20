"use client";

import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  applyAdminPlatformConfiguration,
  getAdminPlatformConfiguration,
  previewAdminPlatformConfiguration,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  type AdminPlatformPreview,
  adminPlatformPreviewInputSchema,
  adminPlatformPreviewRetainedSchema,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AdminJobLink } from "@/components/admin/activity/AdminJobLink";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useOptionalAdminJobRegistration } from "@/lib/admin/adminJobEffects";
import { AdminDisplayError } from "@/lib/admin/adminRequestError";
import { useAdminDraft } from "@/lib/admin/useAdminDraft";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import {
  activityJobQueryOptions,
  hasUnresolvedJobObservation,
  useActivityClient,
} from "../activity/activityQueries";
import { JobDetail } from "../activity/JobDetail";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";
import { usePlatformPreviewDiscard } from "./PlatformPreviewLifecycle";
import {
  buildPlatformCandidate,
  PLATFORM_SCOPE_FIELDS,
  PLATFORM_SCOPE_HREF,
  type PlatformDraft,
  type PlatformScope,
  platformPreviewWithinScope,
} from "./platformScope";

type View = Awaited<ReturnType<typeof getAdminPlatformConfiguration>> & { status: 200 };
type Configuration = AdminPlatformPreview["configuration"];
type Field = keyof AdminPlatformPreview["values"];
/** Field order on the page; each field's label and help live in `adminSettings.platform.fields`. */
const FIELDS: Field[] = [
  "domain",
  "acmeEmail",
  "releaseSelector",
  "defaultRegion",
  "backupRetentionDays",
];
const emptyConfirmations = {
  domain: false,
  dnsTls: false,
  oauth: false,
  passkeys: false,
  alternateLogin: false,
};

/** Effective ownership and retained job links stay available after a browser reconnect. */
class PlatformScopeError extends AdminDisplayError {}
export function PlatformConfiguration({ scope = "deployment" }: { scope?: PlatformScope } = {}) {
  const t = useTranslations("adminSettings.platform");
  const { actorId } = useAccountAdmin(),
    { client, apiUrl } = useActivityClient();
  const query = useQuery({
    queryKey: ["admin", "platform", apiUrl, actorId],
    enabled: !!actorId,
    retry: false,
    refetchInterval: 10000,
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(await getAdminPlatformConfiguration({ client, signal })),
  });
  return (
    <Paper variant="outlined" sx={{ p: 2, maxWidth: 800 }}>
      <Typography component="h2" variant="subtitle1" sx={{ fontWeight: 650 }}>
        {t("title", { scope })}
      </Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>{t("reload")}</Button>}
        >
          {t("unavailable")}
        </Alert>
      )}
      {query.data ? (
        <PlatformForm
          key={JSON.stringify([apiUrl, actorId, scope, query.data.expectedCurrentRevisionId])}
          view={query.data}
          actorId={actorId}
          scope={scope}
          onReload={() => void query.refetch()}
        />
      ) : (
        !query.isError && <Typography>{t("loading")}</Typography>
      )}
    </Paper>
  );
}
function PlatformForm({
  view,
  actorId,
  scope,
  onReload,
}: {
  view: View["data"];
  actorId: string;
  scope: PlatformScope;
  onReload: () => void;
}) {
  const t = useTranslations("adminSettings.platform");
  const tShared = useTranslations("adminShared");
  const register = useOptionalAdminJobRegistration();
  const queryClient = useQueryClient();
  const { client, apiUrl } = useActivityClient(),
    storageKey = `openmapx-platform-preview:${apiUrl}:${actorId}:${scope}`;
  const owner = useAdminMutationOwner(
    client,
    JSON.stringify([actorId, scope, view.expectedCurrentRevisionId]),
  );
  const scopeFields: readonly Field[] = PLATFORM_SCOPE_FIELDS[scope];
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (
      !(
        (scope === "retention" && id === "backup-retention") ||
        (scope === "release" && id === "release-selector")
      )
    )
      return;
    const timer = setTimeout(() => {
      const field = document.getElementById(id);
      field?.scrollIntoView?.({ block: "center" });
      (
        field?.querySelector<HTMLElement>("input:not(:disabled),button:not(:disabled)") ?? field
      )?.focus();
    }, 0);
    return () => clearTimeout(timer);
  }, [scope]);
  const [retained, setRetained] = useState<ReturnType<
    typeof adminPlatformPreviewRetainedSchema.parse
  > | null>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = adminPlatformPreviewRetainedSchema.parse(JSON.parse(raw));
      const valid =
        parsed.preview.actorId === actorId &&
        parsed.preview.expectedCurrentRevisionId === view.expectedCurrentRevisionId &&
        Date.parse(parsed.expiresAt) > Date.now() &&
        platformPreviewWithinScope(
          parsed.preview,
          view,
          buildPlatformCandidate(view.configuration, parsed.preview.configuration, scope),
          scope,
        );
      if (!valid) sessionStorage.removeItem(storageKey);
      return valid ? parsed : null;
    } catch {
      return null;
    }
  });
  const ordinaryDraft = useAdminDraft({
    id: `platform:${scope}`,
    baseline: Object.fromEntries(scopeFields.map((key) => [key, view.configuration[key] ?? null])),
    editableKeys: scopeFields,
    signature: "platform-v1",
  });
  const draft = buildPlatformCandidate(
    view.configuration,
    ordinaryDraft.values as PlatformDraft,
    scope,
  );
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    if (retained && !ordinaryDraft.dirty)
      ordinaryDraft.setValues(
        Object.fromEntries(
          scopeFields.map((key) => [key, retained.preview.configuration[key] ?? null]),
        ),
      );
  }, [retained, ordinaryDraft, scopeFields]);
  const [confirmations, setConfirmations] = useState(emptyConfirmations),
    [proof, setProof] = useState<string>(),
    [reauth, setReauth] = useState(false),
    [accepted, setAccepted] = useState<string>(),
    [, tick] = useState(0);
  const previewEpoch = useRef(0);
  const previewKey = useRef<string | null>(null),
    applyKey = useRef<string | null>(null);
  const acceptedJob = useQuery({
    ...activityJobQueryOptions(client, apiUrl, accepted, "application"),
    refetchInterval: 5000,
  });
  const observedTerminal =
    !!acceptedJob.data?.finishedAt &&
    ["success", "failed", "canceled"].includes(acceptedJob.data.status) &&
    !hasUnresolvedJobObservation(acceptedJob.data.result);
  const pending = view.pending ?? [],
    busy = pending.length > 0 || (!!accepted && !observedTerminal);
  const clearPreview = () => {
    previewEpoch.current++;
    setRetained(null);
    setConfirmations(emptyConfirmations);
    setProof(undefined);
    setReauth(false);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage is optional for local discard. */
    }
    previewKey.current = null;
    applyKey.current = null;
  };
  const freshView = async () => {
    let fresh: View["data"];
    try {
      fresh = unwrapAdminResponse(await getAdminPlatformConfiguration({ client }));
    } catch {
      throw new PlatformScopeError(t("refreshFailed"));
    }
    if (!owner.active) throw new PlatformScopeError(t("viewChanged"));
    if (fresh.expectedCurrentRevisionId !== view.expectedCurrentRevisionId)
      throw new PlatformScopeError(t("revisionChanged"));
    if (fresh.pending.length) throw new PlatformScopeError(t("operationPending"));
    return fresh;
  };
  const previewMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      const epoch = previewEpoch.current;
      const fresh = await freshView();
      if (epoch !== previewEpoch.current) throw new PlatformScopeError(t("draftChanged"));
      const edits = Object.fromEntries(
        ordinaryDraft.dirtyKeys.map((key) => [key, ordinaryDraft.values[key]]),
      ) as PlatformDraft;
      const candidate = buildPlatformCandidate(fresh.configuration, edits, scope);
      const parsed = adminPlatformPreviewInputSchema.safeParse({
        expectedCurrentRevisionId: fresh.expectedCurrentRevisionId,
        changes: candidate,
      });
      if (!parsed.success) throw new PlatformScopeError(t("invalidFields"));
      previewKey.current ??= crypto.randomUUID();
      const value = unwrapAdminResponse(
        await previewAdminPlatformConfiguration(
          parsed.data,
          { "idempotency-key": previewKey.current },
          { client },
        ),
      );
      if (!platformPreviewWithinScope(value.preview, fresh, candidate, scope))
        throw new PlatformScopeError(t("previewOutOfScope"));
      return { value, fresh, epoch };
    },
    onError: () => {
      if (owner.active) previewKey.current = null;
    },
    onSuccess: ({ value, fresh, epoch }) => {
      if (!owner.active || epoch !== previewEpoch.current) return;
      queryClient.setQueryData(["admin", "platform", apiUrl, actorId], fresh);
      setRetained(value);
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      applyKey.current = null;
    },
  });
  const applyMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!retained || Date.parse(retained.expiresAt) <= Date.now())
        throw new PlatformScopeError(t("previewExpired"));
      const fresh = await freshView();
      const candidate = buildPlatformCandidate(
        fresh.configuration,
        retained.preview.configuration,
        scope,
      );
      if (!platformPreviewWithinScope(retained.preview, fresh, candidate, scope))
        throw new PlatformScopeError(t("previewNoLongerInScope"));
      applyKey.current ??= crypto.randomUUID();
      const accepted = await unwrapAdminResponse(
        await applyAdminPlatformConfiguration(
          {
            expectedCurrentRevisionId: retained.preview.expectedCurrentRevisionId,
            previewFingerprint: retained.preview.previewFingerprint,
            confirmations,
            ...(proof ? { domainProofToken: proof } : {}),
          },
          { "idempotency-key": applyKey.current },
          { client },
        ),
      );
      register?.({
        client,
        apiUrl,
        jobId: accepted.jobId,
        label: t("jobLabel"),
        kind: "platform",
        returnTo: PLATFORM_SCOPE_HREF[scope],
        onSettled: () => queryClient.invalidateQueries({ queryKey: ["admin", "platform", apiUrl] }),
      });
      return accepted;
    },
    onSuccess: (value) => {
      if (!owner.active) return;
      setAccepted(value.jobId);
      clearPreview();
    },
  });
  usePlatformPreviewDiscard(scope, () => {
    clearPreview();
    previewMutation.reset();
    applyMutation.reset();
  });
  useEffect(() => {
    if (!retained) return;
    const timeout = setTimeout(
      () => tick((x) => x + 1),
      Math.max(1, Date.parse(retained.expiresAt) - Date.now() + 1),
    );
    return () => clearTimeout(timeout);
  }, [retained]);
  const working = previewMutation.isPending || applyMutation.isPending;
  const edit = (key: Field, value: Configuration[Field]) => {
    clearPreview();
    previewMutation.reset();
    applyMutation.reset();
    ordinaryDraft.setValues((old) => ({ ...old, [key]: value }));
  };
  const validInput = adminPlatformPreviewInputSchema.safeParse({
    expectedCurrentRevisionId: view.expectedCurrentRevisionId,
    changes: draft,
  }).success;
  const previewInScope =
    !retained ||
    platformPreviewWithinScope(
      retained.preview,
      view,
      buildPlatformCandidate(view.configuration, retained.preview.configuration, scope),
      scope,
    );
  const preview = retained?.preview,
    expired = !!retained && Date.parse(retained.expiresAt) <= Date.now();
  return (
    <Stack sx={{ gap: 2, pt: 1 }}>
      {scope === "deployment" && (
        <Stack direction="row" useFlexGap sx={{ gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <Typography variant="body2">
            {t("releaseSelector", { selector: view.values.releaseSelector ?? "" })}
          </Typography>
          <Button component={Link} href="/admin/system/updates#release-selector">
            {t("manageReleaseSelection")}
          </Button>
        </Stack>
      )}
      <Typography variant="body2">{t("hostOwnedHelp")}</Typography>
      {FIELDS.filter((key) => scopeFields.includes(key)).map((key) => {
        const label = t(`fields.${key}.label`);
        const field = draft[key],
          managed = field?.source === "database";
        const value = managed ? field.value : view.values[key];
        return (
          <Stack
            key={key}
            tabIndex={-1}
            id={
              key === "backupRetentionDays"
                ? "backup-retention"
                : key === "releaseSelector"
                  ? "release-selector"
                  : undefined
            }
            sx={{ gap: 0.75, maxWidth: 560, scrollMarginTop: 80 }}
          >
            <TextField
              label={label}
              value={value ?? ""}
              disabled={!managed || working || busy}
              type={key === "backupRetentionDays" ? "number" : "text"}
              helperText={t("fieldHelp", {
                help: t(`fields.${key}.help`),
                source: view.sources[key],
              })}
              onChange={(e) =>
                edit(key, {
                  source: "database",
                  value: key === "backupRetentionDays" ? Number(e.target.value) : e.target.value,
                } as Configuration[Field])
              }
            />
            <Button
              sx={{ alignSelf: "start" }}
              disabled={working || busy}
              onClick={() =>
                edit(
                  key,
                  managed
                    ? { source: "host" }
                    : ({
                        source: "database",
                        value: view.values[key] ?? "",
                      } as Configuration[Field]),
                )
              }
            >
              {managed ? t("returnToHost", { label }) : t("manageInUi", { label })}
            </Button>
          </Stack>
        );
      })}
      {ordinaryDraft.conflicts.length > 0 && (
        <Alert
          severity="warning"
          action={
            <Button onClick={() => ordinaryDraft.keepEdits()}>{tShared("keepMyEdits")}</Button>
          }
        >
          {t("ownershipChanged", {
            fieldLabels: ordinaryDraft.conflicts.map((key) => t(`fields.${key}.label`)).join(", "),
          })}
        </Alert>
      )}
      {!validInput && <Alert severity="info">{t("completeFields")}</Alert>}
      {!previewInScope && (
        <Alert severity="error" action={<Button onClick={onReload}>{t("reloadState")}</Button>}>
          {t("previewNotPreserved")}
        </Alert>
      )}
      {previewMutation.isError && (
        <Alert severity="error" action={<Button onClick={onReload}>{t("reloadState")}</Button>}>
          {t("previewUnavailable", {
            detail:
              previewMutation.error instanceof PlatformScopeError
                ? previewMutation.error.message
                : "",
          })}
        </Alert>
      )}
      {applyMutation.isError && (
        <Alert severity="error" action={<Button onClick={onReload}>{t("reloadState")}</Button>}>
          {applyMutation.error instanceof PlatformScopeError
            ? t("applyNotStarted", { detail: applyMutation.error.message })
            : t("applyNotConfirmed")}
        </Alert>
      )}
      <Stack direction="row" sx={{ gap: 1 }}>
        <Button
          variant="outlined"
          disabled={working || busy || !validInput || ordinaryDraft.conflicts.length > 0}
          onClick={() => previewMutation.mutate()}
        >
          {t("preview")}
        </Button>
        {ordinaryDraft.dirty && (
          <Button
            disabled={working || busy}
            onClick={() => {
              clearPreview();
              ordinaryDraft.discard();
              previewMutation.reset();
              applyMutation.reset();
            }}
          >
            {tShared("discard")}
          </Button>
        )}
      </Stack>
      {preview && (
        <Stack sx={{ gap: 1 }}>
          <Typography variant="h6">{t("reviewTitle")}</Typography>
          <Typography>
            {t("publicOrigin", { oldOrigin: preview.oldOrigin, newOrigin: preview.newOrigin })}
          </Typography>
          <Typography>
            {preview.affectedServiceIds.length
              ? t("affectedServices", { services: preview.affectedServiceIds.join(", ") })
              : t("noAffectedServices")}
          </Typography>
          <Typography variant="body2">
            {t("reconnectAt", { publicOrigin: preview.newOrigin })}
          </Typography>
          <Button href={`${preview.newOrigin}/admin`} target="_blank" rel="noopener noreferrer">
            {t("openReviewedAddress")}
          </Button>
          {preview.warnings.map((warning) => (
            <Alert key={warning} severity="warning">
              {warning}
            </Alert>
          ))}
          {Object.entries(preview.requiredConfirmation)
            .filter(([, required]) => required)
            .map(([key]) => (
              <FormControlLabel
                key={key}
                control={
                  <Checkbox
                    checked={confirmations[key as keyof typeof confirmations]}
                    onChange={(e) =>
                      setConfirmations((old) => ({ ...old, [key]: e.target.checked }))
                    }
                  />
                }
                label={t("confirmation", { key })}
              />
            ))}
          {preview.requiredConfirmation.alternateLogin && (
            <>
              <Alert severity="warning">{t("alternateLoginRequired")}</Alert>
              <Button disabled={working || expired} onClick={() => setReauth(true)}>
                {proof ? t("verifyAgain") : t("verifyAlternateLogin")}
              </Button>
            </>
          )}
          {expired && <Alert severity="warning">{t("previewExpiredCreate")}</Alert>}
          <Button
            variant="contained"
            disabled={
              working ||
              busy ||
              expired ||
              !previewInScope ||
              Object.entries(preview.requiredConfirmation).some(
                ([key, required]) => required && !confirmations[key as keyof typeof confirmations],
              ) ||
              (preview.requiredConfirmation.alternateLogin && !proof)
            }
            onClick={() => applyMutation.mutate()}
          >
            {t("applyReviewed")}
          </Button>
        </Stack>
      )}
      {reauth && preview && (
        <AdminReauthenticationDialog
          purpose="platform.domain.apply"
          targetId={preview.previewFingerprint}
          intentFingerprint={preview.previewFingerprint}
          onClose={() => setReauth(false)}
          onCompleted={(proofs) => {
            setProof(proofs[0]?.challengeId);
            setReauth(false);
          }}
        />
      )}
      {busy && <Alert severity="info">{t("operationRetained")}</Alert>}
      {[...new Set([...pending.map((job) => job.jobId), ...(accepted ? [accepted] : [])])].map(
        (jobId) => (
          <div key={jobId}>
            <AdminJobLink id={jobId} source="application" />
            <JobDetail jobId={jobId} source="application" />
          </div>
        ),
      )}
      <Accordion variant="outlined" disableGutters>
        <AccordionSummary>{t("recoveryCommands")}</AccordionSummary>
        <AccordionDetails>
          <TextField
            label={t("statusCommands")}
            multiline
            value={
              "pnpm openmapx services status\npnpm openmapx services logs ops-agent --tail 200"
            }
            slotProps={{ input: { readOnly: true } }}
            helperText={t("statusCommandsHelp")}
          />
          <Typography variant="caption">{t("recoveryHelp")}</Typography>
        </AccordionDetails>
      </Accordion>
    </Stack>
  );
}
