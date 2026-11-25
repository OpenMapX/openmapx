"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { prefixedStorageKey } from "@openmapx/core";
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
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAdminFormat } from "@/lib/admin/adminFormat";
import { useActivityClient } from "../activity/activityQueries";
import { useConfigSourceLabel } from "../shared/configSourceLabel";
import { AdminReauthenticationDialog } from "../users/AdminReauthenticationDialog";
import { CredentialTransferDialog } from "./CredentialTransferDialog";
import { discardStoredPreview } from "./credential-preview-storage";

import { downloadMigrationJson } from "./migration-json-download";
export function ConfigurationMigrationPanel() {
  const t = useTranslations("adminSettings.migration");
  const sourceLabel = useConfigSourceLabel();
  const { actorId } = useAccountAdmin();
  const format = useAdminFormat();
  const { client, apiUrl } = useActivityClient(),
    [preview, setPreview] = useState<ConfigurationMigrationPreview | null>(null),
    [failure, setFailure] = useState<"sessionUnavailable" | "notSettled" | "fileTooLarge" | null>(
      null,
    ),
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
  const storageKey = prefixedStorageKey(
    "adminConfigurationMigrationPreview",
    JSON.stringify([apiUrl, actorId]),
  );
  const remember = (value: ConfigurationMigrationPreview) => {
    const metadata = configurationMigrationPreviewSchema.parse(value);
    setPreview(metadata);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(metadata));
    } catch {
      /* Optional navigation cache. */
    }
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
        else discardStoredPreview(storageKey);
      }
    } catch {
      discardStoredPreview(storageKey);
    }
    setResult(null);
    if (!apiUrl || !actorId) setFailure("sessionUnavailable");
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
    setFailure(null);
    try {
      await action(current.signal);
    } catch {
      if (owner === epoch.current && !current.signal.aborted) setFailure("notSettled");
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
        discardStoredPreview(storageKey);
        void inventory.refetch();
      }
    });
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={2}>
        <Typography variant="h6">{t("title")}</Typography>
        <Typography>{t("intro", { fields: 1000, groups: 512, keys: 128 })}</Typography>
        {failure && <Alert severity="error">{t(failure)}</Alert>}
        {inventory.isError && <Alert severity="error">{t("inventoryUnavailable")}</Alert>}
        {inventory.data && (
          <Typography>
            {t("inventorySummary", {
              fields: inventory.data.fields.filter((f) => f.included).length,
              prerequisites: inventory.data.document.prerequisites.length,
            })}
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
            {t("export")}
          </Button>
          <Button component="label" disabled={busy}>
            {t("review")}
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
                  setFailure("fileTooLarge");
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
          <Button onClick={() => setCredentials(true)}>{t("credentialTransfer")}</Button>
        </Stack>
        {preview && (
          <>
            <Typography>
              {t("previewSummary", {
                count: preview.changes.length,
                time: format.time(preview.expiresAt),
              })}
            </Typography>
            {preview.prerequisites.map((p) => (
              <Alert key={`${p.scope}:${p.id}:${p.key}:${p.reason}:${p.source}`} severity="info">
                {t("prerequisite", {
                  scope: p.scope,
                  target: p.key ? `${p.id}/${p.key}` : p.id,
                  reason: p.reason,
                  sourceLabel: sourceLabel(p.source),
                })}
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
                  {t("platformOrigin", {
                    oldOrigin: preview.platform.oldOrigin,
                    newOrigin: preview.platform.newOrigin,
                  })}
                </Alert>
                {Object.entries(preview.platform.requiredConfirmation)
                  .filter(([, required]) => required)
                  .map(([key]) => (
                    <FormControlLabel
                      key={key}
                      label={t("confirmation", { key })}
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
              {t("apply")}
            </Button>
          </>
        )}
        {result && (
          <Alert severity={result.outcome === "applied" ? "success" : "warning"}>
            {t("outcome", {
              outcome: result.outcome,
              steps: result.steps
                .map((s) => t("step", { target: `${s.scope}/${s.id}`, status: s.status }))
                .join("; "),
            })}
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
