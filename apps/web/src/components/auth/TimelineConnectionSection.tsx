"use client";

import LaunchIcon from "@mui/icons-material/Launch";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Link from "@mui/material/Link";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  type PersonalTimelineApiError,
  safeHref,
  type TimelineConnectionMode,
  type TimelineConnectionView,
  useConnectTimeline,
  useDisconnectTimeline,
  usePersonalTimelineStore,
  useTestTimelineConnection,
  useTimelineConnection,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { forwardRef, useEffect, useRef, useState } from "react";

const DAWARICH_API_KEY_HELP = "https://dawarich.app/docs/api/dawarich-api/";

interface TimelineConnectionSectionProps {
  ownerId: string;
}

function errorMessageKey(error: PersonalTimelineApiError | null): string | null {
  if (!error?.code) return error ? "unknown" : null;
  switch (error.code) {
    case "TIMELINE_NOT_CONNECTED":
    case "TIMELINE_MANAGED_DISABLED":
    case "TIMELINE_CREDENTIAL_INVALID":
    case "TIMELINE_INSTANCE_UNSUPPORTED":
    case "TIMELINE_PLAN_RESTRICTED":
    case "TIMELINE_RATE_LIMITED":
    case "TIMELINE_UPSTREAM_UNAVAILABLE":
    case "TIMELINE_RESPONSE_INVALID":
      return error.code;
    default:
      return "unknown";
  }
}

function hasHealthyManagedSetup(view: TimelineConnectionView | null | undefined): boolean {
  return Boolean(view?.managed.available && view.managed.healthy);
}

function managedSettingsUrl(view: TimelineConnectionView): string | null {
  if (!hasHealthyManagedSetup(view) || !view.managed.publicOrigin) return null;
  try {
    const parsed = new URL(view.managed.publicOrigin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return `${parsed.origin}/users/edit`;
  } catch {
    return null;
  }
}

export const TimelineConnectionSection = forwardRef<
  HTMLHeadingElement,
  TimelineConnectionSectionProps
>(function TimelineConnectionSection({ ownerId }, headingRef) {
  const t = useTranslations("account.timeline");
  const tc = useTranslations("common");
  const locale = useLocale();
  const connectionQuery = useTimelineConnection(ownerId);
  const connectMutation = useConnectTimeline(ownerId);
  const testMutation = useTestTimelineConnection(ownerId);
  const disconnectMutation = useDisconnectTimeline(ownerId);
  const view = connectionQuery.data ?? null;
  const current = view?.connection ?? null;
  const [mode, setMode] = useState<TimelineConnectionMode>(() =>
    hasHealthyManagedSetup(view) ? "managed" : "external",
  );
  const [editing, setEditing] = useState(() => !view?.connected);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const keyRef = useRef(apiKey);
  const [validationKey, setValidationKey] = useState<string | null>(null);
  const [connectErrorKey, setConnectErrorKey] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const activeOwnerId = useRef<string | null>(ownerId);
  const initializedFromView = useRef(Boolean(view));
  const previouslyConnected = useRef(Boolean(view?.connected));

  keyRef.current = apiKey;

  useEffect(() => {
    if (!view) return;
    if (!initializedFromView.current) {
      initializedFromView.current = true;
      setEditing(!view.connected);
      setMode(
        view.connected
          ? (view.connection?.mode ?? "external")
          : hasHealthyManagedSetup(view)
            ? "managed"
            : "external",
      );
    } else if (!previouslyConnected.current && view.connected) {
      setEditing(false);
      setApiKey("");
    }
    if (editing && mode === "managed" && !hasHealthyManagedSetup(view)) {
      keyRef.current = "";
      setApiKey("");
      setMode("external");
    }
    previouslyConnected.current = view.connected;
  }, [editing, mode, view]);

  useEffect(
    () => () => {
      keyRef.current = "";
    },
    [],
  );

  useEffect(() => {
    activeOwnerId.current = ownerId;
    return () => {
      activeOwnerId.current = null;
    };
  }, [ownerId]);

  const mutationError =
    connectMutation.error ?? testMutation.error ?? disconnectMutation.error ?? null;
  const displayedError = mutationError ?? connectionQuery.error;
  const displayedErrorKey = connectErrorKey ?? errorMessageKey(displayedError);

  const clearSecret = () => {
    keyRef.current = "";
    setApiKey("");
  };

  const clearErrors = () => {
    setValidationKey(null);
    setConnectErrorKey(null);
    connectMutation.reset();
    testMutation.reset();
    disconnectMutation.reset();
  };

  const chooseMode = (nextMode: TimelineConnectionMode) => {
    if (nextMode === mode) return;
    clearSecret();
    clearErrors();
    setMode(nextMode);
  };

  const beginEdit = (nextMode: TimelineConnectionMode, retainMetadata: boolean) => {
    clearSecret();
    clearErrors();
    setMode(nextMode);
    setInstanceUrl(retainMetadata && current?.mode === "external" ? current.publicOrigin : "");
    setDisplayName(retainMetadata && current?.mode === "external" ? current.displayName : "");
    setEditing(true);
  };

  const cancelEdit = () => {
    clearSecret();
    clearErrors();
    setEditing(false);
    setInstanceUrl("");
    setDisplayName("");
  };

  const validateExternal = (): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(instanceUrl.trim());
    } catch {
      setValidationKey("validationUrl");
      return false;
    }
    if (parsed.protocol !== "https:") {
      setValidationKey("validationHttps");
      return false;
    }
    if (parsed.username || parsed.password || parsed.hash) {
      setValidationKey("validationUrl");
      return false;
    }
    return true;
  };

  const submitConnection = async () => {
    clearErrors();
    if (!apiKey.trim()) {
      setValidationKey("validationApiKey");
      return;
    }
    if (mode === "external" && !validateExternal()) return;

    try {
      if (mode === "managed") {
        await connectMutation.mutateAsync({ mode, apiKey });
      } else {
        await connectMutation.mutateAsync({
          mode,
          instanceUrl: instanceUrl.trim(),
          apiKey,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        });
      }
      clearSecret();
      connectMutation.reset();
      setEditing(false);
    } catch (error) {
      setConnectErrorKey(errorMessageKey(error as PersonalTimelineApiError) ?? "unknown");
      clearSecret();
      connectMutation.reset();
    }
  };

  const runTest = async () => {
    clearErrors();
    try {
      await testMutation.mutateAsync();
    } catch {
      // TanStack mutation state supplies the stable, sanitized error code.
    }
  };

  const runDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      if (activeOwnerId.current !== ownerId) return;
      usePersonalTimelineStore.getState().resetForSession();
      clearSecret();
      setConfirmDisconnect(false);
      setEditing(true);
      setInstanceUrl("");
      setDisplayName("");
    } catch {
      // The dialog remains open and shows the sanitized mutation error.
    }
  };

  const formattedValidatedAt = current
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(current.validatedAt),
      )
    : null;
  const settingsUrl = view ? managedSettingsUrl(view) : null;
  const managedReady = hasHealthyManagedSetup(view);
  const busy = connectMutation.isPending || disconnectMutation.isPending;

  return (
    <Box component="section" aria-labelledby="account-timeline-heading" sx={{ mb: 3 }}>
      <Typography
        ref={headingRef}
        id="account-timeline-heading"
        component="h2"
        variant="subtitle2"
        tabIndex={-1}
        sx={{ fontWeight: 600, mb: 1.5, scrollMarginTop: 16, outlineOffset: 4 }}
      >
        {t("heading")}
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, lineHeight: 1.55 }}>
        {t("description")}
      </Typography>

      {connectionQuery.isPending && (
        <Stack
          role="status"
          direction="row"
          spacing={1}
          sx={{ minHeight: 44, alignItems: "center" }}
        >
          <CircularProgress size={18} />
          <Typography variant="body2">{t("loading")}</Typography>
        </Stack>
      )}

      {displayedErrorKey && (
        <Alert
          severity="error"
          action={
            connectionQuery.error ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => void connectionQuery.refetch()}
                sx={{ minHeight: 44, minWidth: 44 }}
              >
                {tc("retry")}
              </Button>
            ) : undefined
          }
          sx={{ mb: 2 }}
        >
          {t(`errors.${displayedErrorKey}`)}
        </Alert>
      )}

      {current && !editing ? (
        <Stack spacing={1.5}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Typography variant="body1" sx={{ fontWeight: 650 }}>
              {current.displayName}
            </Typography>
            <Chip size="small" label={t(`status.${current.status}`)} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
            {current.publicOrigin}
          </Typography>
          <Box
            component="dl"
            sx={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 12px", m: 0 }}
          >
            <Typography component="dt" variant="caption" color="text.secondary">
              {t("modeLabel")}
            </Typography>
            <Typography component="dd" variant="caption" sx={{ m: 0 }}>
              {t(current.mode === "managed" ? "modeManaged" : "modeExternal")}
            </Typography>
            <Typography component="dt" variant="caption" color="text.secondary">
              {t("timezone")}
            </Typography>
            <Typography component="dd" variant="caption" sx={{ m: 0 }}>
              {current.timeZone}
            </Typography>
            {current.upstreamEmail && (
              <>
                <Typography component="dt" variant="caption" color="text.secondary">
                  {t("upstreamAccount")}
                </Typography>
                <Typography
                  component="dd"
                  variant="caption"
                  sx={{ m: 0, overflowWrap: "anywhere" }}
                >
                  {current.upstreamEmail}
                </Typography>
              </>
            )}
            <Typography component="dt" variant="caption" color="text.secondary">
              {t("validatedAt")}
            </Typography>
            <Typography component="dd" variant="caption" sx={{ m: 0 }}>
              {formattedValidatedAt}
            </Typography>
          </Box>
          {current.status !== "connected" && (
            <Alert severity={current.status === "invalid" ? "error" : "warning"}>
              {t(`connectionState.${current.status}`)}
            </Alert>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button
              size="small"
              onClick={() => void runTest()}
              disabled={testMutation.isPending}
              sx={{ minHeight: 44 }}
            >
              {testMutation.isPending ? t("testing") : t("test")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                beginEdit(
                  current.mode === "managed" && !managedReady ? "external" : current.mode,
                  true,
                )
              }
              sx={{ minHeight: 44 }}
            >
              {t("replace")}
            </Button>
            <Button
              size="small"
              onClick={() =>
                beginEdit(
                  current.mode === "external" && managedReady ? "managed" : "external",
                  false,
                )
              }
              sx={{ minHeight: 44 }}
            >
              {t("switch")}
            </Button>
            <Button
              component="a"
              href={safeHref(current.publicOrigin)}
              target="_blank"
              rel="noopener noreferrer"
              size="small"
              endIcon={<LaunchIcon fontSize="small" />}
              sx={{ minHeight: 44 }}
            >
              {t("openDawarich")}
            </Button>
            <Button
              color="error"
              size="small"
              onClick={() => setConfirmDisconnect(true)}
              sx={{ minHeight: 44 }}
            >
              {t("disconnect")}
            </Button>
          </Stack>
        </Stack>
      ) : !connectionQuery.isPending && view ? (
        <Stack spacing={2}>
          <FormControl>
            <FormLabel id="timeline-mode-label">{t("modeLabel")}</FormLabel>
            <RadioGroup
              aria-labelledby="timeline-mode-label"
              value={mode}
              onChange={(event) => chooseMode(event.target.value as TimelineConnectionMode)}
            >
              {managedReady && (
                <FormControlLabel
                  value="managed"
                  control={<Radio slotProps={{ input: { "aria-label": t("modeManaged") } }} />}
                  label={
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <span>{t("modeManaged")}</span>
                      <Chip size="small" color="primary" label={t("recommended")} />
                    </Stack>
                  }
                  sx={{ minHeight: 44 }}
                />
              )}
              <FormControlLabel
                value="external"
                control={<Radio slotProps={{ input: { "aria-label": t("modeExternal") } }} />}
                label={t("modeExternal")}
                sx={{ minHeight: 44 }}
              />
            </RadioGroup>
          </FormControl>

          {!managedReady && <Alert severity="info">{t("managedUnavailable")}</Alert>}

          {mode === "managed" ? (
            <Stack spacing={1.5}>
              <Typography variant="body2">{t("managedSsoExplanation")}</Typography>
              <Typography variant="body2">{t("managedApiKeyStep")}</Typography>
              <Button
                variant="outlined"
                endIcon={<LaunchIcon />}
                disabled={!settingsUrl}
                onClick={() => {
                  if (settingsUrl) window.open(settingsUrl, "_blank", "noopener,noreferrer");
                }}
                sx={{ alignSelf: "flex-start", minHeight: 44 }}
              >
                {t("openManagedSettings")}
              </Button>
            </Stack>
          ) : (
            <Stack spacing={1.5}>
              <TextField
                fullWidth
                type="url"
                label={t("instanceUrl")}
                value={instanceUrl}
                onChange={(event) => setInstanceUrl(event.target.value)}
                autoComplete="url"
                slotProps={{ htmlInput: { "aria-required": true } }}
              />
              <TextField
                fullWidth
                label={t("displayName")}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="off"
              />
              <Link
                href={safeHref(DAWARICH_API_KEY_HELP)}
                target="_blank"
                rel="noopener noreferrer"
                sx={{
                  alignSelf: "flex-start",
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: 44,
                }}
              >
                {t("externalApiKeyHelp")}
              </Link>
            </Stack>
          )}

          <TextField
            fullWidth
            type="password"
            label={t("apiKey")}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoComplete="off"
            slotProps={{ htmlInput: { "aria-required": true } }}
          />

          {validationKey && <Alert severity="error">{t(validationKey)}</Alert>}

          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button
              variant="contained"
              onClick={() => void submitConnection()}
              disabled={busy}
              sx={{ minHeight: 44 }}
            >
              {connectMutation.isPending ? t("connecting") : t("connect")}
            </Button>
            {current && (
              <Button onClick={cancelEdit} disabled={busy} sx={{ minHeight: 44 }}>
                {t("cancelEdit")}
              </Button>
            )}
          </Stack>
        </Stack>
      ) : null}

      <Dialog open={confirmDisconnect} onClose={() => setConfirmDisconnect(false)} maxWidth="xs">
        <DialogTitle>{t("disconnectTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t("disconnectKeepsHistory")}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDisconnect(false)} sx={{ minHeight: 44, minWidth: 44 }}>
            {tc("cancel")}
          </Button>
          <Button
            autoFocus
            color="error"
            variant="contained"
            onClick={() => void runDisconnect()}
            disabled={disconnectMutation.isPending}
            sx={{ minHeight: 44, minWidth: 44 }}
          >
            {t("confirmDisconnect")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
});
