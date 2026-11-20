"use client";

import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Accordion from "@mui/material/Accordion";
import AccordionDetails from "@mui/material/AccordionDetails";
import AccordionSummary from "@mui/material/AccordionSummary";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useRef, useState } from "react";
import { useActivityClient } from "@/components/admin/activity/activityQueries";
import {
  type DawarichProvisioningApiError,
  type ManagedDawarichProvisioningStatus,
  type ProvisioningSecretState,
  useDawarichProvisioning,
} from "@/hooks/useDawarichProvisioning";
import { type AdminTranslator, useAdminTranslations } from "@/lib/admin/adminTranslator";
import { useAdminMutationOwner } from "@/lib/admin/useAdminMutationOwner";

const ROTATION_CONFIRMATION = "ROTATE DAWARICH OIDC SECRET";

function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const withoutDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  const normalized = withoutDot.toLowerCase();
  const labels = normalized.split(".");
  if (
    normalized.length > 253 ||
    labels.length < 2 ||
    !/^[a-z0-9.-]+$/.test(normalized) ||
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return null;
  }
  return normalized;
}

function errorMessage(error: Error | null, t: AdminTranslator<"adminServices">): string | null {
  if (!error) return null;
  const code = (error as DawarichProvisioningApiError).code ?? error.message;
  switch (code) {
    case "DAWARICH_DATABASE_SECRET_CONFLICT":
      return t("dawarichDatabaseSecretConflict");
    case "DAWARICH_RAILS_SECRET_CONFLICT":
      return t("dawarichRailsSecretConflict");
    case "DAWARICH_OAUTH_CLIENT_CONFLICT":
      return t("dawarichOauthClientConflict");
    case "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED":
      return t("dawarichOidcSecretRecovery");
    case "DAWARICH_BUNDLE_NOT_INSTALLED":
      return t("dawarichBundleNotInstalled");
    case "DAWARICH_INVALID_PUBLIC_HOST":
      return t("dawarichInvalidPublicHost");
    default:
      return t("dawarichProvisioningFailed");
  }
}

function stateLabel(value: boolean, t: AdminTranslator<"adminServices">): string {
  return value ? t("checklistReady") : t("checklistPending");
}

function secretLabel(state: ProvisioningSecretState, t: AdminTranslator<"adminServices">): string {
  return state === "consistent"
    ? t("checklistReady")
    : state === "missing"
      ? t("checklistMissing")
      : t("checklistConflict");
}

function ChecklistRow({ label, status, ready }: { label: string; status: string; ready: boolean }) {
  return (
    <Stack direction="row" sx={{ alignItems: "center", justifyContent: "space-between", gap: 2 }}>
      <Typography variant="body2">{label}</Typography>
      <Chip
        size="small"
        label={status}
        color={ready ? "success" : status === "Conflict" ? "error" : "default"}
        variant={ready ? "filled" : "outlined"}
      />
    </Stack>
  );
}

function SetupChecklist({ status }: { status: ManagedDawarichProvisioningStatus }) {
  const t = useAdminTranslations("adminServices");
  return (
    <Stack spacing={1}>
      <ChecklistRow
        label={t("bundleInstalled")}
        status={stateLabel(status.installed, t)}
        ready={status.installed}
      />
      <ChecklistRow
        label={t("oauthClient")}
        status={stateLabel(
          status.oauthClient.present &&
            status.oauthClient.settingsMatch &&
            !status.oauthClient.recoveryRequired,
          t,
        )}
        ready={
          status.oauthClient.present &&
          status.oauthClient.settingsMatch &&
          !status.oauthClient.recoveryRequired
        }
      />
      <ChecklistRow
        label={t("databaseSecret")}
        status={secretLabel(status.secrets.databasePassword, t)}
        ready={status.secrets.databasePassword === "consistent"}
      />
      <ChecklistRow
        label={t("railsSecret")}
        status={secretLabel(status.secrets.secretKeyBase, t)}
        ready={status.secrets.secretKeyBase === "consistent"}
      />
      <ChecklistRow
        label={t("oidcSecret")}
        status={secretLabel(status.secrets.oidcClientSecret, t)}
        ready={status.secrets.oidcClientSecret === "consistent"}
      />
      <ChecklistRow
        label={t("configurationReady")}
        status={stateLabel(status.configReady, t)}
        ready={status.configReady}
      />
      <ChecklistRow
        label={t("selected")}
        status={stateLabel(status.selected, t)}
        ready={status.selected}
      />
      <ChecklistRow
        label={t("runningAndHealthy")}
        status={stateLabel(status.running && status.healthy, t)}
        ready={status.running && status.healthy}
      />
      <ChecklistRow
        label={t("publicOrigin")}
        status={status.publicOrigin ?? t("pending")}
        ready={Boolean(status.publicOrigin)}
      />
    </Stack>
  );
}

export function ManagedDawarichSetup() {
  const { client, apiUrl } = useActivityClient();
  return <ManagedDawarichSetupView key={apiUrl} client={client} apiUrl={apiUrl} />;
}

function ManagedDawarichSetupView({ client, apiUrl }: ReturnType<typeof useActivityClient>) {
  const t = useAdminTranslations("adminServices");
  const { statusQuery, provision, rotate } = useDawarichProvisioning();
  const [hostname, setHostname] = useState("");
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const status = statusQuery.data;
  const [feedback, setFeedback] = useState<Error | null>(null);
  const feedbackSequence = useRef(0);
  const owner = useAdminMutationOwner(client, JSON.stringify([apiUrl, hostname, confirmation]));
  const mutationError = errorMessage(feedback, t);

  async function handleProvision() {
    const normalized = normalizeHostname(hostname);
    if (normalized === null) {
      setHostnameError(t("enterADnsHostnameWithout"));
      return;
    }
    setHostnameError(null);
    const execution = owner;
    const sequence = ++feedbackSequence.current;
    setFeedback(null);
    provision.reset();
    try {
      await provision.mutateAsync(normalized || undefined);
    } catch (error) {
      if (execution.active && sequence === feedbackSequence.current)
        setFeedback(error instanceof Error ? error : new Error());
    }
  }

  async function handleRotate() {
    const execution = owner;
    const sequence = ++feedbackSequence.current;
    setFeedback(null);
    rotate.reset();
    try {
      await rotate.mutateAsync();
      if (execution.active && sequence === feedbackSequence.current) setConfirmation("");
    } catch (error) {
      if (execution.active && sequence === feedbackSequence.current)
        setFeedback(error instanceof Error ? error : new Error());
    }
  }

  return (
    <Card variant="outlined" sx={{ borderColor: "primary.main" }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography component="h2" variant="h6">
              {t("managedDawarichSetup")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("provisioningIsIdempotentItPrepares")}
            </Typography>
          </Box>

          {statusQuery.isLoading && (
            <CircularProgress size={24} aria-label={t("loadingSetupStatus")} />
          )}
          {statusQuery.isError && (
            <Alert severity="error">{errorMessage(statusQuery.error, t)}</Alert>
          )}
          {status && <SetupChecklist status={status} />}
          {status?.oauthClient.recoveryRequired && (
            <Alert severity="error">{t("oidcRecoveryIsIncompleteDo")}</Alert>
          )}
          {mutationError && <Alert severity="error">{mutationError}</Alert>}

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            sx={{ alignItems: "flex-start" }}
          >
            <TextField
              size="small"
              fullWidth
              label={t("publicHostnameOptional")}
              placeholder="timeline.example.com"
              value={hostname}
              error={Boolean(hostnameError)}
              helperText={hostnameError ?? t("firstRunDefaultsToTimeline")}
              onChange={(event) => setHostname(event.target.value)}
              slotProps={{ htmlInput: { autoCapitalize: "none", spellCheck: false } }}
            />
            <Button
              variant="contained"
              onClick={handleProvision}
              disabled={provision.isPending}
              sx={{ whiteSpace: "nowrap" }}
            >
              {provision.isPending ? t("provisioning") : t("provisionReconcile")}
            </Button>
          </Stack>

          {status?.readyToStart && (
            <Alert severity={status.needsApply ? "info" : "success"}>
              {status.needsApply ? t("provisioningIsReadyButNot") : t("provisioningIsReadyAndThe")}
            </Alert>
          )}

          <Typography variant="body2" color="text.secondary">
            {t("browserSsoAndTimelineApi")}
          </Typography>

          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle2">{t("oidcSecretRecovery")}</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                <Alert severity="warning">{t("theOldSecretBecomesInvalid")}</Alert>
                <TextField
                  size="small"
                  label={t("typeConfirmation")}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  helperText={ROTATION_CONFIRMATION}
                  fullWidth
                />
                <Button
                  color="error"
                  variant="outlined"
                  disabled={confirmation !== ROTATION_CONFIRMATION || rotate.isPending}
                  onClick={handleRotate}
                >
                  {rotate.isPending ? t("rotating") : t("rotateOidcSecret")}
                </Button>
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </CardContent>
    </Card>
  );
}
