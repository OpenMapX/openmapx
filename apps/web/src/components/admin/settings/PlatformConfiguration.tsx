"use client";
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
  adminPlatformPreviewRetainedSchema,
} from "@openmapx/core/api-contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { activityJobQueryOptions, useActivityClient } from "../activity/activityQueries";
import { JobDetail } from "../activity/JobDetail";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";

type View = Awaited<ReturnType<typeof getAdminPlatformConfiguration>> & { status: 200 };
type Configuration = AdminPlatformPreview["configuration"];
type Field = keyof AdminPlatformPreview["values"];
const fields: { key: Field; label: string; help: string }[] = [
  {
    key: "domain",
    label: "Domain",
    help: "Hostname only. Requires DNS/TLS, login and passkey recovery review.",
  },
  { key: "acmeEmail", label: "ACME contact email", help: "Certificate renewal contact." },
  {
    key: "releaseSelector",
    label: "Release selector",
    help: "Channel, exact version or local. Existing images stay pinned until an explicit checked update.",
  },
  {
    key: "defaultRegion",
    label: "Default region",
    help: "Optional resource region. The deployment allowlist still applies.",
  },
  {
    key: "backupRetentionDays",
    label: "Backup retention (days)",
    help: "1–36500 days. Applies to creation, restore and scheduled/manual pruning.",
  },
];
const confirmationLabels = {
  domain: "I have reviewed the new public origin",
  dnsTls: "DNS and TLS are ready for the new domain",
  oauth: "OAuth provider callback URLs are ready",
  passkeys: "I understand that existing passkeys may require recovery",
  alternateLogin: "I have proved an alternate supported password login and second factor",
};
const emptyConfirmations = {
  domain: false,
  dnsTls: false,
  oauth: false,
  passkeys: false,
  alternateLogin: false,
};

/** Effective ownership and retained job links stay available after a browser reconnect. */
export function PlatformConfiguration() {
  const { actorId } = useAccountAdmin(),
    { client, apiUrl } = useActivityClient();
  const query = useQuery({
    queryKey: ["admin", "platform", apiUrl, actorId],
    enabled: !!actorId,
    retry: false,
    refetchInterval: 10000,
    queryFn: async () => unwrapAdminResponse(await getAdminPlatformConfiguration({ client })),
  });
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6">Platform configuration</Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Reload</Button>}
        >
          Platform state is unavailable. Inspect Activity and host recovery guidance before changing
          configuration.
        </Alert>
      )}
      {query.data ? (
        <PlatformForm
          key={JSON.stringify([apiUrl, actorId, query.data.expectedCurrentRevisionId])}
          view={query.data}
          actorId={actorId}
        />
      ) : (
        !query.isError && <Typography>Loading platform configuration…</Typography>
      )}
    </Paper>
  );
}
function PlatformForm({ view, actorId }: { view: View["data"]; actorId: string }) {
  const { client, apiUrl } = useActivityClient(),
    storageKey = `openmapx-platform-preview:${apiUrl}:${actorId}`;
  const [retained, setRetained] = useState<ReturnType<
    typeof adminPlatformPreviewRetainedSchema.parse
  > | null>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = adminPlatformPreviewRetainedSchema.parse(JSON.parse(raw));
      return parsed.preview.actorId === actorId &&
        parsed.preview.expectedCurrentRevisionId === view.expectedCurrentRevisionId &&
        Date.parse(parsed.expiresAt) > Date.now()
        ? parsed
        : null;
    } catch {
      return null;
    }
  });
  const [draft, setDraft] = useState<Configuration>(
      retained?.preview.configuration ?? view.configuration,
    ),
    [confirmations, setConfirmations] = useState(emptyConfirmations),
    [proof, setProof] = useState<string>(),
    [reauth, setReauth] = useState(false),
    [accepted, setAccepted] = useState<string>(),
    [, tick] = useState(0);
  const previewKey = useRef<string | null>(null),
    applyKey = useRef<string | null>(null);
  const acceptedJob = useQuery({
    ...activityJobQueryOptions(client, apiUrl, accepted, "application"),
    refetchInterval: 5000,
  });
  const observedTerminal =
    !!acceptedJob.data?.finishedAt &&
    ["success", "failed", "canceled"].includes(acceptedJob.data.status);
  const pending = view.pending ?? [],
    busy = pending.length > 0 || (!!accepted && !observedTerminal);
  const clearPreview = () => {
    setRetained(null);
    setConfirmations(emptyConfirmations);
    setProof(undefined);
    setReauth(false);
    sessionStorage.removeItem(storageKey);
    previewKey.current = null;
    applyKey.current = null;
  };
  const previewMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      previewKey.current ??= crypto.randomUUID();
      return unwrapAdminResponse(
        await previewAdminPlatformConfiguration(
          { expectedCurrentRevisionId: view.expectedCurrentRevisionId, changes: draft },
          { "idempotency-key": previewKey.current },
          { client },
        ),
      );
    },
    onError: () => {
      previewKey.current = null;
    },
    onSuccess: (value) => {
      setRetained(value);
      sessionStorage.setItem(storageKey, JSON.stringify(value));
      applyKey.current = null;
    },
  });
  const applyMutation = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!retained || Date.parse(retained.expiresAt) <= Date.now()) throw Error("Preview expired");
      applyKey.current ??= crypto.randomUUID();
      return unwrapAdminResponse(
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
    },
    onSuccess: (value) => {
      setAccepted(value.jobId);
      clearPreview();
    },
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
    setDraft((old) => ({ ...old, [key]: value }));
  };
  const preview = retained?.preview,
    expired = !!retained && Date.parse(retained.expiresAt) <= Date.now();
  return (
    <Stack sx={{ gap: 2, pt: 1 }}>
      <Typography variant="body2">
        Host-owned values are locked until you explicitly adopt them. Returning a field to the host
        uses its current environment value. Previewing does not save or restart services.
      </Typography>
      {fields.map(({ key, label, help }) => {
        const field = draft[key],
          managed = field?.source === "database";
        const value = managed ? field.value : view.values[key];
        return (
          <Stack key={key} sx={{ gap: 1 }}>
            <TextField
              label={label}
              value={value ?? ""}
              disabled={!managed || working || busy}
              type={key === "backupRetentionDays" ? "number" : "text"}
              helperText={`${help} Current source: ${view.sources[key]}.`}
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
              {managed ? `Return ${label} to host` : `Manage ${label} in UI`}
            </Button>
          </Stack>
        );
      })}
      {previewMutation.isError && (
        <Alert severity="error">
          Preview unavailable. The revision, input or source may have changed. Reload before
          retrying; your draft is retained.
        </Alert>
      )}
      {applyMutation.isError && (
        <Alert severity="error">
          Apply was not confirmed. Inspect Activity before retrying with the same request. If the
          preview or policy changed, reload and review a new preview.
        </Alert>
      )}
      <Button disabled={working || busy} onClick={() => previewMutation.mutate()}>
        Preview changes
      </Button>
      {preview && (
        <Stack sx={{ gap: 1 }}>
          <Typography variant="h6">Review platform changes</Typography>
          <Typography>
            Public origin: {preview.oldOrigin} → {preview.newOrigin}
          </Typography>
          <Typography>
            Affected services: {preview.affectedServiceIds.join(", ") || "None"}
          </Typography>
          <Typography variant="body2">
            Reconnect at {preview.newOrigin}/admin after a domain change. Keep host access available
            if DNS, TLS, login or the control plane cannot recover.
          </Typography>
          <Button href={`${preview.newOrigin}/admin`} target="_blank" rel="noopener noreferrer">
            Open reviewed admin address
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
                label={confirmationLabels[key as keyof typeof confirmationLabels]}
              />
            ))}
          {preview.requiredConfirmation.alternateLogin && (
            <>
              <Alert severity="warning">
                A fresh supported password login and effective second factor are required.
                Passkey-only or OAuth sessions cannot authorize a domain change. Establish a
                supported alternate login first.
              </Alert>
              <Button disabled={working || expired} onClick={() => setReauth(true)}>
                {proof ? "Verify sign-in again" : "Verify alternate login"}
              </Button>
            </>
          )}
          {expired && <Alert severity="warning">This preview expired. Create a new preview.</Alert>}
          <Button
            variant="contained"
            disabled={
              working ||
              busy ||
              expired ||
              Object.entries(preview.requiredConfirmation).some(
                ([key, required]) => required && !confirmations[key as keyof typeof confirmations],
              ) ||
              (preview.requiredConfirmation.alternateLogin && !proof)
            }
            onClick={() => applyMutation.mutate()}
          >
            Apply reviewed changes
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
      {busy && (
        <Alert severity="info">
          An original platform operation is retained. Follow its outcome in Activity; disconnecting
          does not cancel it. Unknown outcomes require recovery before another apply.
        </Alert>
      )}
      {[...new Set([...pending.map((job) => job.jobId), ...(accepted ? [accepted] : [])])].map(
        (jobId) => (
          <JobDetail key={jobId} jobId={jobId} source="application" />
        ),
      )}
      <TextField
        label="Host status commands"
        multiline
        value={"pnpm openmapx services status\npnpm openmapx services logs ops-agent --tail 200"}
        slotProps={{ input: { readOnly: true } }}
        helperText="Copy and run on the deployment host. Diagnose the original operation before changing state."
      />
      <Typography variant="caption">
        Host recovery: inspect the retained operation in Activity and the host ops-agent journal. Do
        not delete locks or replay an uncertain update. Bootstrap secrets, Docker installation and
        offline agent recovery require host access.
      </Typography>
    </Stack>
  );
}
