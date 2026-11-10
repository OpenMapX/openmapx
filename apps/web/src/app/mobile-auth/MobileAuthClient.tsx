"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { useEnv } from "@/integration-api/runtime/EnvProvider";

/**
 * The page the installed app opens in the system browser.
 *
 * It exists because embedded user agents are not a durable contract for OAuth or
 * WebAuthn. Everything the user does here is ordinary web sign-in on the real
 * origin, with the real URL bar visible — which is the security property that
 * makes this worth the complexity in the first place.
 *
 * Three things this page must never do, in decreasing order of how bad it would
 * be: put the one-time token anywhere in the URL, accept a redirect target from
 * a query parameter, or keep any of it after the redirect. The callback is a
 * fixed path on this page's own origin, which the association files under
 * `/.well-known` bind to the official app, so the OS hands it to that app and
 * no other. Nothing on this page chooses where the user goes next.
 */

/** The verified-link path the app waits for. */
const CALLBACK_PATH = "/mobile-auth/callback";

export type AuthPurpose = "sign-in" | "link-provider" | "add-passkey";

export interface MobileAuthClientProps {
  purpose: AuthPurpose;
  state: string;
  codeChallenge: string;
}

type Phase = "idle" | "working" | "error";

export function MobileAuthClient({ purpose, state, codeChallenge }: MobileAuthClientProps) {
  const t = useTranslations("mobileAuth");
  const { apiUrl } = useEnv();
  const { data: session, isPending } = useSession();
  const [phase, setPhase] = useState<Phase>("idle");
  const authenticated = Boolean(session);
  // better-auth reports every refetch of an empty session as pending, and the
  // password step triggers one just before it asks for a two-factor code.
  // Hiding the dialog then would remount it on its password form, so only the
  // first session check keeps it hidden.
  const [sessionChecked, setSessionChecked] = useState(!isPending);
  useEffect(() => {
    if (!isPending) setSessionChecked(true);
  }, [isPending]);
  // Signing in happens here, in the real browser, where OAuth providers and
  // platform passkeys work. Every sign-in route returns to this exact handoff
  // so the app's state and challenge survive a provider round trip.
  const returnPath = useMemo(() => {
    const query = new URLSearchParams({
      purpose,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `/mobile-auth?${query.toString()}`;
  }, [codeChallenge, purpose, state]);

  const purposeText = useMemo(() => {
    if (purpose === "link-provider") return t("purposeLinkProvider");
    if (purpose === "add-passkey") return t("purposeAddPasskey");
    return t("purposeSignIn");
  }, [purpose, t]);

  const finish = useCallback(async () => {
    setPhase("working");
    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/mobile-auth/issue`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose, state, codeChallenge }),
      });
      if (!response.ok) {
        setPhase("error");
        return;
      }
      const body = (await response.json()) as { callbackCode?: unknown };
      if (typeof body.callbackCode !== "string") {
        setPhase("error");
        return;
      }

      // This origin's fixed callback path plus the two values the app is
      // waiting for. No token, no session data, no caller-supplied destination.
      const callback = new URL(CALLBACK_PATH, window.location.origin);
      callback.searchParams.set("code", body.callbackCode);
      callback.searchParams.set("state", state);
      window.location.replace(callback.toString());
    } catch {
      setPhase("error");
    }
  }, [apiUrl, codeChallenge, purpose, state]);

  const cancel = useCallback(() => {
    // Closing is the honest cancel: the app treats a dismissed browser as
    // cancelled, and nothing has been issued.
    window.close();
  }, []);

  return (
    <Box sx={{ maxWidth: 420, mx: "auto", px: 3, py: 6, textAlign: "center" }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        {t("title")}
      </Typography>
      <Typography sx={{ mb: 3, color: "text.secondary" }}>{purposeText}</Typography>

      {!authenticated && sessionChecked && (
        <>
          <Alert severity="info" sx={{ mb: 3, textAlign: "left" }}>
            {t("signInFirst")}
          </Alert>
          <AuthDialog open dismissible={false} onClose={() => {}} callbackPath={returnPath} />
        </>
      )}

      {phase === "error" && (
        <Alert severity="error" role="alert" sx={{ mb: 3, textAlign: "left" }}>
          {t("failed")}
        </Alert>
      )}

      <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Button
          variant="contained"
          disabled={!authenticated || isPending || phase === "working"}
          onClick={() => void finish()}
          startIcon={phase === "working" ? <CircularProgress size={16} /> : undefined}
        >
          {t("continueToApp")}
        </Button>
        <Button variant="text" onClick={cancel} disabled={phase === "working"}>
          {t("cancel")}
        </Button>
      </Box>
    </Box>
  );
}
