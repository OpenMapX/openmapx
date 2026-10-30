"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import {
  applyAdminConfigurationMigration,
  exportAdminConfigurationMigration,
  getAdminConfigurationMigrationInventory,
  previewAdminConfigurationMigration,
  unwrapAdminResponse,
} from "@openmapx/core/api-admin-sdk";
import {
  type ConfigurationMigrationPreview,
  configurationMigrationDocumentSchema,
  configurationMigrationPreviewSchema,
} from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useActivityClient } from "../activity/activityQueries";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";
import { CredentialTransferDialog } from "./CredentialTransferDialog";

import { downloadMigrationJson } from "./migration-json-download";
export function ConfigurationMigrationPanel() {
  const { actorId } = useAccountAdmin();
  const { client, apiUrl } = useActivityClient(),
    [preview, setPreview] = useState<ConfigurationMigrationPreview | null>(null),
    [error, setError] = useState(""),
    [result, setResult] = useState<{
      outcome: string;
      steps: Array<{ scope: string; id: string; status: string }>;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [credentials, setCredentials] = useState(false),
    [platformConfirmations, setPlatformConfirmations] = useState({
      domain: false,
      dnsTls: false,
      oauth: false,
      passkeys: false,
      alternateLogin: false,
    }),
    [platformReauth, setPlatformReauth] = useState(false),
    controller = useRef<AbortController | null>(null),
    epoch = useRef(0);
  const storageKey = `openmapx-configuration-migration-preview:${JSON.stringify([apiUrl, actorId])}`;
  const remember = (value: ConfigurationMigrationPreview) => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify(configurationMigrationPreviewSchema.parse(value)),
    );
    setPreview(value);
  };
  useEffect(() => {
    epoch.current++;
    controller.current?.abort();
    setPreview(null);
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const value = configurationMigrationPreviewSchema.parse(JSON.parse(raw));
        if (Date.parse(value.expiresAt) > Date.now()) setPreview(value);
        else sessionStorage.removeItem(storageKey);
      }
    } catch {
      sessionStorage.removeItem(storageKey);
    }
    setResult(null);
    if (!apiUrl || !actorId) setError("Administrator session unavailable");
    return () => {
      epoch.current++;
      controller.current?.abort();
    };
  }, [apiUrl, actorId, storageKey]);
  const inventory = useQuery({
    queryKey: ["admin", "migration-inventory", apiUrl, actorId],
    retry: false,
    queryFn: async ({ signal }) =>
      unwrapAdminResponse(
        await getAdminConfigurationMigrationInventory({
          client,
          signal,
          maxJsonBytes: 1048576,
          maxErrorBytes: 65536,
        }),
      ),
  });
  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    controller.current?.abort();
    const current = new AbortController(),
      owner = epoch.current;
    controller.current = current;
    setBusy(true);
    setError("");
    try {
      await action(current.signal);
    } catch {
      if (owner === epoch.current && !current.signal.aborted)
        setError("Migration did not settle. Inspect Activity before submitting another operation.");
    } finally {
      if (owner === epoch.current) setBusy(false);
    }
  };

  const apply = async (proofToken?: string) =>
    run(async (signal) => {
      if (!preview) return;
      const body = {
        previewId: preview.previewId,
        fingerprint: preview.fingerprint,
        ...(preview.platform
          ? {
              platformAuthorization: {
                confirmations: platformConfirmations,
                ...(proofToken ? { proofToken } : {}),
              },
            }
          : {}),
      };
      const value = unwrapAdminResponse(
        await applyAdminConfigurationMigration(
          body,
          { "idempotency-key": crypto.randomUUID() },
          { client, signal, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
        ),
      );
      if (!signal.aborted) {
        setResult(value);
        setPreview(null);
        sessionStorage.removeItem(storageKey);
        void inventory.refetch();
      }
    });
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">Configuration migration</Typography>
        <Typography>
          Export portable database configuration. Host overrides, credentials and bootstrap secrets
          require separate preparation. Authentication settings are staged for explicit policy
          Apply. A file may contain up to1,000 fields,512 change groups and128 keys per group. The
          full resulting configuration, including retained values, must fit512KiB.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {inventory.isError && (
          <Alert severity="error">Configuration inventory is unavailable.</Alert>
        )}
        {inventory.data && (
          <Typography>
            {inventory.data.fields.filter((f) => f.included).length} portable fields;{" "}
            {inventory.data.document.prerequisites.length} prerequisites. Review every omission
            before applying.
          </Typography>
        )}
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1}>
          <Button
            disabled={busy || !inventory.data}
            onClick={() =>
              void run(async (signal) => {
                downloadMigrationJson(
                  unwrapAdminResponse(
                    await exportAdminConfigurationMigration({
                      client,
                      signal,
                      maxJsonBytes: 1048576,
                      maxErrorBytes: 65536,
                    }),
                  ),
                  "openmapx-configuration.json",
                );
              })
            }
          >
            Export configuration
          </Button>
          <Button component="label" disabled={busy}>
            Review configuration file
            <input
              type="file"
              hidden
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                setPreview(null);
                if (!file) return;
                if (file.size > 1048576) {
                  setError("Configuration file must be at most1MiB.");
                  return;
                }
                void run(async (signal) => {
                  const document = configurationMigrationDocumentSchema.parse(
                      JSON.parse(await file.text()),
                    ),
                    response = unwrapAdminResponse(
                      await previewAdminConfigurationMigration(
                        document,
                        { "idempotency-key": crypto.randomUUID() },
                        { client, signal, maxJsonBytes: 1048576, maxErrorBytes: 65536 },
                      ),
                    );
                  if (!signal.aborted)
                    remember(configurationMigrationPreviewSchema.parse(response));
                });
              }}
            />
          </Button>
          <Button onClick={() => setCredentials(true)}>Protected credential transfer</Button>
        </Stack>
        {preview && (
          <>
            <Typography>
              {preview.changes.length} selected changes. Preview expires{" "}
              {new Date(preview.expiresAt).toLocaleTimeString()}.
            </Typography>
            {preview.prerequisites.map((p) => (
              <Alert key={`${p.scope}:${p.id}:${p.key}:${p.reason}:${p.source}`} severity="info">
                {p.scope}/{p.id}
                {p.key ? `/${p.key}` : ""}: {p.reason} (
                {p.source === "config.json" ? "file" : p.source})
              </Alert>
            ))}
            {preview.denials.map((d) => (
              <Alert severity="error" key={d}>
                {d}
              </Alert>
            ))}
            {preview.platform && (
              <>
                <Alert severity="warning">
                  Platform origin: {preview.platform.oldOrigin} → {preview.platform.newOrigin}.
                  Services and login consumers activate under the same guarded migration.
                </Alert>
                {Object.entries(preview.platform.requiredConfirmation)
                  .filter(([, required]) => required)
                  .map(([key]) => (
                    <FormControlLabel
                      key={key}
                      label={
                        {
                          domain: "I reviewed the new public origin",
                          dnsTls: "DNS and TLS are ready",
                          oauth: "OAuth callback URLs are ready",
                          passkeys: "I reviewed passkey recovery",
                          alternateLogin:
                            "I have an alternate supported password login and second factor",
                        }[key]
                      }
                      control={
                        <Checkbox
                          checked={platformConfirmations[key as keyof typeof platformConfirmations]}
                          onChange={(_, checked) =>
                            setPlatformConfirmations((v) => ({ ...v, [key]: checked }))
                          }
                        />
                      }
                    />
                  ))}
              </>
            )}
            <Button
              disabled={
                busy ||
                !!preview.denials.length ||
                Date.parse(preview.expiresAt) <= Date.now() ||
                (!!preview.platform &&
                  Object.entries(preview.platform.requiredConfirmation).some(
                    ([key, required]) =>
                      required && !platformConfirmations[key as keyof typeof platformConfirmations],
                  ))
              }
              onClick={() => {
                if (preview.platform?.requiredConfirmation.domain) setPlatformReauth(true);
                else void apply();
              }}
            >
              Apply reviewed configuration
            </Button>
          </>
        )}
        {result && (
          <Alert severity={result.outcome === "applied" ? "success" : "warning"}>
            Migration outcome: {result.outcome}.{" "}
            {result.steps.map((s) => `${s.scope}/${s.id}: ${s.status}`).join("; ")}
          </Alert>
        )}
        {platformReauth && preview?.platform && (
          <AdminReauthenticationDialog
            purpose="platform.domain.apply"
            targetId={preview.platform.previewFingerprint}
            intentFingerprint={preview.platform.previewFingerprint}
            onCompleted={(proofs) => {
              setPlatformReauth(false);
              void apply(proofs[0]?.challengeId);
            }}
            onClose={() => setPlatformReauth(false)}
          />
        )}
        {credentials && (
          <CredentialTransferDialog
            onClose={() => setCredentials(false)}
            inventory={
              inventory.data?.fields
                .filter(
                  (f) =>
                    f.ownership.secret &&
                    f.ownership.source === "vault" &&
                    (f.scope === "integration" || f.scope === "service"),
                )
                .map((f) => ({
                  scope: f.scope as "integration" | "service",
                  id: f.id,
                  key: f.key,
                })) ?? []
            }
          />
        )}
      </Stack>
    </Paper>
  );
}
