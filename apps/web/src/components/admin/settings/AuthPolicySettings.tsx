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
import { useRef, useState } from "react";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
export function AuthPolicySettings() {
  const scope = useAccountAdmin(),
    query = useQuery({
      queryKey: scope.keys.policy,
      queryFn: () => scope.client.policy(),
      enabled: !!scope.actorId,
      retry: false,
    });
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6">Authentication policy</Typography>
      {query.isError && (
        <Alert
          severity="error"
          action={<Button onClick={() => void query.refetch()}>Reload</Button>}
        >
          Authentication policy could not be refreshed.
        </Alert>
      )}
      {query.data ? (
        <PolicyForm
          key={JSON.stringify([scope.apiUrl, scope.actorId, query.data.active.revision])}
          view={query.data}
        />
      ) : (
        !query.isError && <Typography>Loading authentication policy…</Typography>
      )}
    </Paper>
  );
}
function PolicyForm({ view }: { view: ReturnType<typeof authPolicyViewSchema.parse> }) {
  const { active, pending, ownership } = view,
    [email, setEmail] = useState(active.emailVerificationRequired),
    [hours, setHours] = useState(String(active.sessionDurationHours)),
    [twoFa, setTwoFa] = useState(active.twoFaEnabled),
    [length, setLength] = useState(String(active.passwordMinLength)),
    [confirmed, setConfirmed] = useState(false),
    [saved, setSaved] = useState(false),
    key = useRef<string | null>(null),
    mutation = useAccountAction("auth-policy", {
      viewKey: active.revision,
      onSuccess: () => {
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
        Object.entries(pending).filter(([key]) =>
          [
            "emailVerificationRequired",
            "sessionDurationHours",
            "twoFaEnabled",
            "passwordMinLength",
          ].includes(key),
        ),
      ),
    });
  return (
    <Stack sx={{ gap: 2, pt: 1 }}>
      <Alert severity="info">
        {active.activationVersion === 0
          ? "Not activated; safe defaults are active. Legacy stored values are drafts until you explicitly activate this policy."
          : "Version 1 authentication policy is active."}
      </Alert>
      <Typography variant="body2">
        Active: email verification {active.emailVerificationRequired ? "required" : "optional"}; new
        sessions {active.sessionDurationHours} hours; new 2FA enrollment{" "}
        {active.twoFaEnabled ? "allowed" : "disabled"}; minimum password {active.passwordMinLength}{" "}
        characters.
      </Typography>
      <Typography variant="caption">
        Revision {active.revision.slice(0, 12)} · Email verification source:{" "}
        {ownership.emailVerificationRequired} · Session, 2FA and password sources:{" "}
        {ownership.sessionDurationHours}, {ownership.twoFaEnabled}, {ownership.passwordMinLength}
      </Typography>
      {Object.keys(pending).length > 0 && (
        <Stack sx={{ gap: 1 }}>
          <Typography variant="subtitle2">Legacy stored draft (not the active policy)</Typography>
          <Typography
            component="pre"
            variant="body2"
            sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
          >
            {Object.entries(pending)
              .map(([key, value]) => {
                const names: Record<string, string> = {
                  emailVerificationRequired: "Email verification",
                  sessionDurationHours: "Session lifetime (hours)",
                  twoFaEnabled: "New 2FA enrollment",
                  passwordMinLength: "Minimum password length",
                };
                return `${names[key] ?? key}: ${typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : typeof value === "number" ? value : "Invalid legacy value"}`;
              })
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
            Load legacy draft
          </Button>
        </Stack>
      )}
      <FormControlLabel
        control={
          <Checkbox
            checked={email}
            onChange={(e) => edit(() => setEmail(e.target.checked))}
            disabled={mutation.isPending || ownership.emailVerificationRequired === "env"}
          />
        }
        label="Require email verification"
      />
      {ownership.emailVerificationRequired === "env" && (
        <Typography variant="caption">Owned by AUTH_EMAIL_VERIFICATION on the host.</Typography>
      )}
      <TextField
        sx={{ maxWidth: 480 }}
        label="New session lifetime (hours)"
        type="number"
        value={hours}
        disabled={mutation.isPending}
        onChange={(e) => edit(() => setHours(e.target.value))}
        slotProps={{ htmlInput: { min: 1, max: 8760, step: 1 } }}
        helperText="1–8760 whole hours. Existing sessions keep their original expiry."
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={twoFa}
            disabled={mutation.isPending}
            onChange={(e) => edit(() => setTwoFa(e.target.checked))}
          />
        }
        label="Allow new 2FA enrollment"
      />
      <Typography variant="caption">
        Turning enrollment off does not remove existing second factors or their sign-in challenges.
      </Typography>
      <TextField
        sx={{ maxWidth: 480 }}
        label="Minimum password length"
        type="number"
        value={length}
        disabled={mutation.isPending}
        onChange={(e) => edit(() => setLength(e.target.value))}
        slotProps={{ htmlInput: { min: 8, max: 128, step: 1 } }}
        helperText="8–128 whole characters. Passwords are limited to 128 characters."
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={confirmed}
            disabled={mutation.isPending}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
        }
        label="I have reviewed all four policy settings"
      />
      {mutation.error && <Alert severity="error">{mutation.error.message}</Alert>}
      {saved && (
        <Alert severity="success">
          Authentication policy applied to new authentication operations.
        </Alert>
      )}
      <Button
        sx={{ alignSelf: "start" }}
        variant="contained"
        disabled={!parsed.success || !confirmed || mutation.isPending}
        onClick={() => {
          if (!parsed.success) return;
          key.current ??= crypto.randomUUID();
          const requestKey = key.current;
          mutation.mutate((client) => client.applyPolicy(parsed.data, active.revision, requestKey));
        }}
      >
        {active.activationVersion === 0
          ? "Activate authentication policy"
          : "Apply authentication policy"}
      </Button>
    </Stack>
  );
}
