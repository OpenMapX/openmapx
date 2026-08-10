"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

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
 * a query parameter, or keep any of it after the redirect. The callback scheme
 * is compiled into the app and echoed by the server-side route only as a fixed
 * literal; nothing on this page chooses where the user goes next.
 */

export type AuthPurpose = "sign-in" | "link-provider" | "add-passkey";

export interface MobileAuthClientProps {
  purpose: AuthPurpose;
  state: string;
  codeChallenge: string;
  /** Compiled into the app; supplied here only so the page can navigate to it. */
  callbackScheme: string;
}

type Phase = "idle" | "working" | "error";

export function MobileAuthClient({
  purpose,
  state,
  codeChallenge,
  callbackScheme,
}: MobileAuthClientProps) {
  const t = useTranslations("mobileAuth");
  const { apiUrl } = useEnv();
  const { data: session, isPending } = useSession();
  const [phase, setPhase] = useState<Phase>("idle");
  const authenticated = Boolean(session);

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

      // Built from the compiled scheme plus the two values the app is waiting
      // for. No token, no session data, no caller-supplied destination.
      const callback = new URL(`${callbackScheme}://auth/callback`);
      callback.searchParams.set("code", body.callbackCode);
      callback.searchParams.set("state", state);
      window.location.replace(callback.toString());
    } catch {
      setPhase("error");
    }
  }, [apiUrl, callbackScheme, codeChallenge, purpose, state]);

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

      {!authenticated && !isPending && (
        <Alert severity="info" sx={{ mb: 3, textAlign: "left" }}>
          {t("signInFirst")}
        </Alert>
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
