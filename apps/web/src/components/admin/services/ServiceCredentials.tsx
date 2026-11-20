"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type {
  AdminServiceCredential,
  AdminServiceCredentialChanged,
} from "@openmapx/core/api-contracts";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import {
  useDeleteServiceCredential,
  useServiceCredentials,
  useSetServiceCredential,
} from "@/hooks/useServices";
import { adminErrorText } from "@/lib/admin/adminRequestError";
import { type AdminTranslator, useAdminTranslations } from "@/lib/admin/adminTranslator";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";
import { useActivityClient } from "../activity/activityQueries";
import { CredentialSetupGuide } from "../integrations/CredentialSetupGuide";
import { useAdminToast } from "../shared/AdminToast";

function applyToast(
  result: AdminServiceCredentialChanged,
  t: AdminTranslator<"adminServices">,
): {
  message: string;
  severity: "success" | "info";
} {
  if ("needsRender" in result && result.needsRender) {
    return {
      message: t("credentialSavedNeedsRender"),
      severity: "info",
    };
  }
  return { message: t("credentialSavedQueued"), severity: "success" };
}

export function ServiceCredentials({ serviceId }: { serviceId: string }) {
  const { apiUrl } = useActivityClient();
  return <ServiceCredentialsView key={JSON.stringify([apiUrl, serviceId])} serviceId={serviceId} />;
}

function ServiceCredentialsView({ serviceId }: { serviceId: string }) {
  const t = useAdminTranslations("adminServices");
  const tCommon = useTranslations("common");
  const { client } = useActivityClient();
  const query = useServiceCredentials(serviceId);
  const setCred = useSetServiceCredential(serviceId);
  const deleteCred = useDeleteServiceCredential(serviceId);
  const showToast = useAdminToast();
  const [editing, setEditing] = useState<AdminServiceCredential | null>(null);
  const [value, setValue] = useState("");
  const [dialogVersion, setDialogVersion] = useState(0);
  const owner = useAdminMutationOwner(
    client,
    JSON.stringify([serviceId, editing?.key, dialogVersion]),
  );

  if (query.isLoading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (query.isError || !query.data) {
    return (
      <Alert severity="error" variant="outlined">
        {t("failedToLoadCredentials")}
      </Alert>
    );
  }

  const { credentials, secretsConfigured } = query.data;

  if (credentials.length === 0) {
    return (
      <Alert severity="info" variant="outlined">
        {t("thisServiceDeclaresNoCredentials")}
      </Alert>
    );
  }

  async function handleSave() {
    if (!editing) return;
    const execution = owner;
    try {
      const result = await setCred.mutateAsync({ key: editing.key, value });
      if (!execution.active) return;
      const { message, severity } = applyToast(result, t);
      showToast(message, severity);
      setEditing(null);
      setValue("");
    } catch (err) {
      if (!execution.active) return;
      showToast(adminErrorText(err, t("failedToSaveCredential")), "error");
    }
  }

  async function handleDelete(key: string) {
    const execution = owner;
    try {
      const result = await deleteCred.mutateAsync(key);
      if (!execution.active) return;
      const { message, severity } = applyToast(result, t);
      showToast(message, severity);
    } catch (err) {
      if (!execution.active) return;
      showToast(adminErrorText(err, t("failedToRemoveCredential")), "error");
    }
  }

  return (
    <Stack spacing={2}>
      {!secretsConfigured && (
        <Alert severity="warning" variant="outlined">
          {t.rich("secretVaultNotConfigured", {
            variable: "OPENMAPX_SECRETS_KEY",
            code: (chunks) => <code>{chunks}</code>,
          })}
        </Alert>
      )}

      {credentials.map((cred) => (
        <Card key={cred.key} variant="outlined">
          <CardContent>
            <Stack
              direction="row"
              spacing={2}
              sx={{ justifyContent: "space-between", alignItems: "center" }}
            >
              <Box>
                <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                  <Typography variant="subtitle2">{cred.title}</Typography>
                  <Chip
                    size="small"
                    label={
                      cred.source === "env"
                        ? t("hostEnvironment")
                        : cred.source === "config.json"
                          ? t("hostFile")
                          : cred.managedBy === "dawarich-provisioning"
                            ? t("managed")
                            : cred.source === "vault"
                              ? t("set")
                              : t("notSet")
                    }
                    color={
                      cred.managedBy === "dawarich-provisioning"
                        ? "info"
                        : cred.source === "vault"
                          ? "success"
                          : "default"
                    }
                    variant={
                      cred.managedBy === "dawarich-provisioning" || cred.source === "vault"
                        ? "filled"
                        : "outlined"
                    }
                  />
                </Stack>
                {cred.description && (
                  <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.5 }}>
                    {cred.description}
                  </Typography>
                )}
                {(cred.source === "env" || cred.source === "config.json") && (
                  <Typography variant="body2">
                    {cred.ownership?.envVar
                      ? t("hostControlledByVariable", { envVar: cred.ownership.envVar })
                      : t("hostControlledRemoveOverride")}
                  </Typography>
                )}
                {cred.managedBy === "transit.credentials" && (
                  <Button component={Link} href="/admin/data/transit?tab=credentials">
                    {t("managePinnedFeedCredentials")}
                  </Button>
                )}
                {cred.updatedAt && (
                  <Typography variant="caption" sx={{ color: "text.secondary" }}>
                    {cred.updatedBy
                      ? t("updatedAtBy", {
                          updatedAt: new Date(cred.updatedAt).toLocaleString(),
                          updatedBy: cred.updatedBy,
                        })
                      : t("updatedAt", { updatedAt: new Date(cred.updatedAt).toLocaleString() })}
                  </Typography>
                )}
                {cred.managedBy === "dawarich-provisioning" && (
                  <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.75 }}>
                    {t("managedDawarichSetupOwnsThis")}
                  </Typography>
                )}
              </Box>
              {!cred.managedBy && (
                <Stack direction="row" spacing={1}>
                  <Button
                    size="small"
                    variant="contained"
                    disabled={
                      !secretsConfigured ||
                      cred.ownership?.writable === false ||
                      ["env", "config.json"].includes(cred.source)
                    }
                    onClick={() => {
                      setCred.reset();
                      setDialogVersion((v) => v + 1);
                      setEditing(cred);
                      setValue("");
                    }}
                  >
                    {cred.source === "vault" ? t("rotate") : t("set")}
                  </Button>
                  {cred.source === "vault" && (
                    <Button
                      size="small"
                      color="error"
                      onClick={() => handleDelete(cred.key)}
                      disabled={
                        deleteCred.isPending ||
                        cred.ownership?.writable === false ||
                        ["env", "config.json"].includes(cred.source)
                      }
                    >
                      {t("remove")}
                    </Button>
                  )}
                </Stack>
              )}
            </Stack>
            {cred.setup && (
              <Box sx={{ mt: 1.5 }}>
                <CredentialSetupGuide setup={cred.setup} />
              </Box>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} fullWidth maxWidth="sm">
        <DialogTitle>{editing?.title}</DialogTitle>
        <DialogContent>
          {editing?.setup && (
            <Box sx={{ mb: 2 }}>
              <CredentialSetupGuide setup={editing.setup} defaultExpanded />
            </Box>
          )}
          <TextField
            autoFocus
            fullWidth
            type="password"
            label={t("value")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)}>{tCommon("cancel")}</Button>
          <Button
            variant="contained"
            onClick={handleSave}
            disabled={value.trim() === "" || setCred.isPending}
          >
            {t("save")}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
