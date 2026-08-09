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
import { useState } from "react";
import {
  type DawarichProvisioningApiError,
  type ManagedDawarichProvisioningStatus,
  type ProvisioningSecretState,
  useDawarichProvisioning,
} from "@/hooks/useDawarichProvisioning";

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

function errorMessage(error: Error | null): string | null {
  if (!error) return null;
  const code = (error as DawarichProvisioningApiError).code ?? error.message;
  switch (code) {
    case "DAWARICH_DATABASE_SECRET_CONFLICT":
      return "The Dawarich database password copies conflict. Resolve them on the host before retrying.";
    case "DAWARICH_RAILS_SECRET_CONFLICT":
      return "The Dawarich Rails secret copies conflict. Resolve them on the host before retrying.";
    case "DAWARICH_OAUTH_CLIENT_CONFLICT":
      return "The persisted managed OAuth client is duplicated or has incompatible security settings.";
    case "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED":
      return "OIDC secret recovery is required. Restore vault access, then provision again to rotate safely.";
    case "DAWARICH_BUNDLE_NOT_INSTALLED":
      return "The exact managed Dawarich bundle is not installed.";
    case "DAWARICH_INVALID_PUBLIC_HOST":
      return "Enter a valid public DNS hostname.";
    default:
      return "Managed Dawarich provisioning failed. Review the service logs and retry.";
  }
}

function stateLabel(value: boolean): "Ready" | "Pending" {
  return value ? "Ready" : "Pending";
}

function secretLabel(state: ProvisioningSecretState): string {
  return state === "consistent" ? "Ready" : state === "missing" ? "Missing" : "Conflict";
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
  return (
    <Stack spacing={1}>
      <ChecklistRow
        label="Bundle installed"
        status={stateLabel(status.installed)}
        ready={status.installed}
      />
      <ChecklistRow
        label="OAuth client"
        status={stateLabel(
          status.oauthClient.present &&
            status.oauthClient.settingsMatch &&
            !status.oauthClient.recoveryRequired,
        )}
        ready={
          status.oauthClient.present &&
          status.oauthClient.settingsMatch &&
          !status.oauthClient.recoveryRequired
        }
      />
      <ChecklistRow
        label="Database secret"
        status={secretLabel(status.secrets.databasePassword)}
        ready={status.secrets.databasePassword === "consistent"}
      />
      <ChecklistRow
        label="Rails secret"
        status={secretLabel(status.secrets.secretKeyBase)}
        ready={status.secrets.secretKeyBase === "consistent"}
      />
      <ChecklistRow
        label="OIDC secret"
        status={secretLabel(status.secrets.oidcClientSecret)}
        ready={status.secrets.oidcClientSecret === "consistent"}
      />
      <ChecklistRow
        label="Configuration ready"
        status={stateLabel(status.configReady)}
        ready={status.configReady}
      />
      <ChecklistRow label="Selected" status={stateLabel(status.selected)} ready={status.selected} />
      <ChecklistRow
        label="Running and healthy"
        status={stateLabel(status.running && status.healthy)}
        ready={status.running && status.healthy}
      />
      <ChecklistRow
        label="Public origin"
        status={status.publicOrigin ?? "Pending"}
        ready={Boolean(status.publicOrigin)}
      />
    </Stack>
  );
}

export function ManagedDawarichSetup() {
  const { statusQuery, provision, rotate } = useDawarichProvisioning();
  const [hostname, setHostname] = useState("");
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const status = statusQuery.data;
  const mutationError = errorMessage(provision.error ?? rotate.error);

  async function handleProvision() {
    const normalized = normalizeHostname(hostname);
    if (normalized === null) {
      setHostnameError("Enter a DNS hostname without a scheme, path, or port.");
      return;
    }
    setHostnameError(null);
    provision.reset();
    await provision.mutateAsync(normalized || undefined).catch(() => undefined);
  }

  async function handleRotate() {
    rotate.reset();
    await rotate.mutateAsync().catch(() => undefined);
    setConfirmation("");
  }

  return (
    <Card variant="outlined" sx={{ borderColor: "primary.main" }}>
      <CardContent>
        <Stack spacing={2}>
          <Box>
            <Typography component="h2" variant="h6">
              Managed Dawarich setup
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Provisioning is idempotent. It prepares one Better Auth client, file-backed secrets,
              and service configuration; it never starts or purges the bundle.
            </Typography>
          </Box>

          {statusQuery.isLoading && (
            <CircularProgress size={24} aria-label="Loading setup status" />
          )}
          {statusQuery.isError && <Alert severity="error">{errorMessage(statusQuery.error)}</Alert>}
          {status && <SetupChecklist status={status} />}
          {status?.oauthClient.recoveryRequired && (
            <Alert severity="error">
              OIDC recovery is incomplete. Do not apply the bundle yet. Restore vault access, then
              use Provision/reconcile to rotate and synchronize both secret copies.
            </Alert>
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
              label="Public hostname (optional)"
              placeholder="timeline.example.com"
              value={hostname}
              error={Boolean(hostnameError)}
              helperText={
                hostnameError ??
                "First run defaults to timeline.<OpenMapX domain>; later runs preserve the saved host."
              }
              onChange={(event) => setHostname(event.target.value)}
              slotProps={{ htmlInput: { autoCapitalize: "none", spellCheck: false } }}
            />
            <Button
              variant="contained"
              onClick={handleProvision}
              disabled={provision.isPending}
              sx={{ whiteSpace: "nowrap" }}
            >
              {provision.isPending ? "Provisioning…" : "Provision/reconcile"}
            </Button>
          </Stack>

          {status?.readyToStart && (
            <Alert severity={status.needsApply ? "info" : "success"}>
              {status.needsApply
                ? "Provisioning is ready but not fully applied. Select the Dawarich bundle, then use Apply changes to both Dawarich Timeline and Dawarich Sidekiq. This notice stays pending until both containers run the current configuration."
                : "Provisioning is ready and the current configuration is applied to both the app and worker. Disabling preserves its data and user connections."}
            </Alert>
          )}

          <Typography variant="body2" color="text.secondary">
            Browser SSO and timeline API access are separate: each user still creates a Dawarich API
            key and saves it in their OpenMapX account settings.
          </Typography>

          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography variant="subtitle2">OIDC secret recovery</Typography>
            </AccordionSummary>
            <AccordionDetails>
              <Stack spacing={1.5}>
                <Alert severity="warning">
                  The old secret becomes invalid immediately. Apply changes afterward so the app and
                  worker restart with the new mounted secret.
                </Alert>
                <TextField
                  size="small"
                  label="Type confirmation"
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
                  {rotate.isPending ? "Rotating…" : "Rotate OIDC secret"}
                </Button>
              </Stack>
            </AccordionDetails>
          </Accordion>
        </Stack>
      </CardContent>
    </Card>
  );
}
