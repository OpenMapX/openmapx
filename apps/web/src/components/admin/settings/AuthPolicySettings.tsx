"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authPolicySettingsSchema, type authPolicyViewSchema } from "@openmapx/core/api-contracts";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAccountErrorText } from "@/lib/admin/useAccountErrorText";
import { useAdminDraft } from "@/lib/admin/useAdminDraft";
import { useAdminFieldFocus } from "@/lib/admin/useAdminFieldFocus";
import { useConfigSourceLabel } from "../shared/configSourceLabel";

const POLICY_KEYS = [
  "emailVerificationRequired",
  "sessionDurationHours",
  "twoFaEnabled",
  "passwordMinLength",
] as const;

export function AuthPolicySettings({ focusKey }: { focusKey?: string } = {}) {
  const t = useTranslations("adminSettings.auth");
  const scope = useAccountAdmin(),
    query = useQuery({
      queryKey: scope.keys.policy,
      queryFn: ({ signal }) => scope.client.policy(signal),
      enabled: !!scope.actorId,
      retry: false,
    });
  useAdminFieldFocus(focusKey, !!query.data);
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6">{t("title")}</Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>{t("reload")}</Button>}
        >
          {t("refreshFailed")}
        </Alert>
      )}
      {query.data ? (
        <PolicyForm
          key={JSON.stringify([scope.apiUrl, scope.actorId, query.data.active.revision])}
          view={query.data}
        />
      ) : (
        !query.isError && <Typography>{t("loading")}</Typography>
      )}
    </Paper>
  );
}
function PolicyForm({ view }: { view: ReturnType<typeof authPolicyViewSchema.parse> }) {
  const t = useTranslations("adminSettings.auth");
  const sourceLabel = useConfigSourceLabel();
  const errorText = useAccountErrorText();
  const { active, pending, ownership } = view;
  const draft = useAdminDraft({
    id: "authentication-policy",
    signature: "policy-v1",
    baseline: {
      emailVerificationRequired: active.emailVerificationRequired,
      sessionDurationHours: String(active.sessionDurationHours),
      twoFaEnabled: active.twoFaEnabled,
      passwordMinLength: String(active.passwordMinLength),
    },
    editableKeys: [
      "sessionDurationHours",
      "twoFaEnabled",
      "passwordMinLength",
      ...(ownership.emailVerificationRequired === "env" ? [] : ["emailVerificationRequired"]),
    ],
  });
  const submitted = useRef<Record<string, unknown>>({});
  const email = Boolean(draft.values.emailVerificationRequired ?? active.emailVerificationRequired),
    hours = String(draft.values.sessionDurationHours),
    twoFa = Boolean(draft.values.twoFaEnabled),
    length = String(draft.values.passwordMinLength);
  const setEmail = (value: boolean) =>
    draft.setValues((old) => ({ ...old, emailVerificationRequired: value }));
  const setHours = (value: string) =>
    draft.setValues((old) => ({ ...old, sessionDurationHours: value }));
  const setTwoFa = (value: boolean) => draft.setValues((old) => ({ ...old, twoFaEnabled: value }));
  const setLength = (value: string) =>
    draft.setValues((old) => ({ ...old, passwordMinLength: value }));
  const [confirmed, setConfirmed] = useState(false),
    [saved, setSaved] = useState(false),
    key = useRef<string | null>(null),
    mutation = useAccountAction("auth-policy", {
      viewKey: active.revision,
      onSuccess: () => {
        draft.acknowledge(submitted.current);
        setConfirmed(false);
        setSaved(true);
      },
    }),
    parsed = authPolicySettingsSchema.safeParse({
      emailVerificationRequired: email,
      sessionDurationHours: Number(hours),
      twoFaEnabled: twoFa,
      passwordMinLength: Number(length),
    }),
    edit = (run: () => void) => {
      key.current = null;
      setConfirmed(false);
      setSaved(false);
      run();
    },
    legacy = authPolicySettingsSchema.safeParse({
      emailVerificationRequired: active.emailVerificationRequired,
      sessionDurationHours: active.sessionDurationHours,
      twoFaEnabled: active.twoFaEnabled,
      passwordMinLength: active.passwordMinLength,
      ...Object.fromEntries(
        Object.entries(pending).filter(([key]) => (POLICY_KEYS as readonly string[]).includes(key)),
      ),
    });
  /** One line of the legacy draft: a known setting and its value, worded. */
  const legacyLine = (name: string, value: unknown) => {
    const kind =
      typeof value === "boolean" ? String(value) : typeof value === "number" ? "number" : "invalid";
    const setting = (POLICY_KEYS as readonly string[]).includes(name) ? name : "other";
    return t("legacyLine", {
      setting,
      name,
      kind,
      value: typeof value === "number" ? value : 0,
    });
  };
  return (
    <Stack sx={{ gap: 2, pt: 1 }}>
      <Alert severity="info">
        {active.activationVersion === 0 ? t("notActivated") : t("activeVersion")}
      </Alert>
      <Typography variant="body2">
        {t("activeSummary", {
          email: String(active.emailVerificationRequired),
          hours: active.sessionDurationHours,
          twoFa: String(active.twoFaEnabled),
          length: active.passwordMinLength,
        })}
      </Typography>
      <Typography variant="caption">
        {t("revisionSources", {
          revision: active.revision.slice(0, 12),
          emailSource: sourceLabel(ownership.emailVerificationRequired),
          sessionSource: sourceLabel(ownership.sessionDurationHours),
          twoFaSource: sourceLabel(ownership.twoFaEnabled),
          passwordSource: sourceLabel(ownership.passwordMinLength),
        })}
      </Typography>
      {Object.keys(pending).length > 0 && (
        <Stack sx={{ gap: 1 }}>
          <Typography variant="subtitle2">{t("legacyDraft")}</Typography>
          <Typography
            component="pre"
            variant="body2"
            sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {Object.entries(pending)
              .map(([name, value]) => legacyLine(name, value))
              .join("\n")}
          </Typography>
          <Button
            sx={{ alignSelf: "start" }}
            disabled={!legacy.success || mutation.isPending}
            onClick={() => {
              if (!legacy.success) return;
              edit(() => {
                setEmail(
                  ownership.emailVerificationRequired === "env"
                    ? active.emailVerificationRequired
                    : legacy.data.emailVerificationRequired,
                );
                setHours(String(legacy.data.sessionDurationHours));
                setTwoFa(legacy.data.twoFaEnabled);
                setLength(String(legacy.data.passwordMinLength));
              });
            }}
          >
            {t("loadLegacyDraft")}
          </Button>
        </Stack>
      )}
      <FormControlLabel
        id="setting-auth.emailVerificationRequired"
        control={
          <Checkbox
            checked={email}
            onChange={(e) => edit(() => setEmail(e.target.checked))}
            disabled={mutation.isPending || ownership.emailVerificationRequired === "env"}
          />
        }
        label={t("requireEmailVerification")}
      />
      {ownership.emailVerificationRequired === "env" && (
        <Typography variant="caption">
          {t("ownedByHost", { variable: "AUTH_EMAIL_VERIFICATION_REQUIRED" })}
        </Typography>
      )}
      <TextField
        sx={{ maxWidth: 480 }}
        id="setting-auth.sessionDurationHours"
        label={t("sessionLifetime")}
        type="number"
        value={hours}
        disabled={mutation.isPending}
        onChange={(e) => edit(() => setHours(e.target.value))}
        slotProps={{ htmlInput: { min: 1, max: 8760, step: 1 } }}
        helperText={t("sessionLifetimeHelp", { min: 1, max: 8760 })}
      />
      <FormControlLabel
        id="setting-auth.twoFaEnabled"
        control={
          <Checkbox
            checked={twoFa}
            disabled={mutation.isPending}
            onChange={(e) => edit(() => setTwoFa(e.target.checked))}
          />
        }
        label={t("allowTwoFa")}
      />
      <Typography variant="caption">{t("twoFaHelp")}</Typography>
      <TextField
        sx={{ maxWidth: 480 }}
        id="setting-auth.passwordMinLength"
        label={t("passwordMinLength")}
        type="number"
        value={length}
        disabled={mutation.isPending}
        onChange={(e) => edit(() => setLength(e.target.value))}
        slotProps={{ htmlInput: { min: 8, max: 128, step: 1 } }}
        helperText={t("passwordMinLengthHelp", { min: 8, max: 128 })}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={confirmed}
            disabled={mutation.isPending}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
        }
        label={t("reviewed")}
      />
      {!!draft.conflicts.length && (
        <Alert
          severity="warning"
          action={<Button onClick={() => edit(() => draft.keepEdits())}>{t("keepEdits")}</Button>}
        >
          {t("policyChanged")}
        </Alert>
      )}
      {draft.dirty && (
        <Button
          sx={{ alignSelf: "start" }}
          disabled={mutation.isPending}
          onClick={() => edit(() => draft.discard())}
        >
          {t("discardEdits")}
        </Button>
      )}
      {mutation.error && <Alert severity="error">{errorText(mutation.error)}</Alert>}
      {saved && <Alert severity="success">{t("applied")}</Alert>}
      <Button
        sx={{ alignSelf: "start" }}
        variant="contained"
        disabled={!parsed.success || !confirmed || mutation.isPending || !!draft.conflicts.length}
        onClick={() => {
          if (!parsed.success) return;
          key.current ??= crypto.randomUUID();
          const requestKey = key.current;
          submitted.current = { ...draft.values };
          mutation.mutate((client) => client.applyPolicy(parsed.data, active.revision, requestKey));
        }}
      >
        {t("apply", { activated: String(active.activationVersion !== 0) })}
      </Button>
    </Stack>
  );
}
