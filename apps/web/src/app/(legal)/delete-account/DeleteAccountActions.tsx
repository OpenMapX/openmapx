"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { authClient, useSession } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { clearPrivateDeviceData } from "@/lib/accountDeletionCleanup";

/**
 * The actionable half of the public deletion page.
 *
 * Both stores require a deletion route that works for somebody who has already
 * uninstalled the app, which is why this lives on the website rather than only
 * in Account Settings. Anybody arriving here without a session is asked to sign
 * in — not redirected somewhere else and not told to reinstall.
 */
export function DeleteAccountActions() {
  const t = useTranslations("legal");
  const tAccount = useTranslations("account");
  const tAuth = useTranslations("auth");
  const tCommon = useTranslations("common");
  const { data: session, isPending } = useSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");

  const remove = useCallback(async () => {
    setState("working");
    try {
      const { error } = await authClient.deleteUser({ callbackURL: "/" });
      if (error) {
        setState("error");
        return;
      }
      await clearPrivateDeviceData({ queryClient });
      setState("done");
    } catch {
      setState("error");
    }
  }, [queryClient]);

  if (isPending) return null;

  if (state === "done") {
    return (
      <Alert severity="success" role="status">
        {t("deleteAccountTimingBody")}
      </Alert>
    );
  }

  if (!session) {
    return (
      <Stack spacing={2}>
        <Typography>{t("deleteAccountSignedOut")}</Typography>
        <Button variant="contained" href="/?signin=1">
          {tAuth("signIn")}
        </Button>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {state === "error" && (
        <Alert severity="error" role="alert">
          {tAccount("failedDeleteAccount")}
        </Alert>
      )}
      {confirming ? (
        <Stack spacing={1}>
          {/* The consequences are stated at the moment of the decision, not
              only further up the page where they can be scrolled past. */}
          <Alert severity="warning">{tAccount("deleteAccountWarning")}</Alert>
          <Button
            variant="contained"
            color="error"
            disabled={state === "working"}
            onClick={() => void remove()}
          >
            {t("deleteAccountButton")}
          </Button>
          <Button variant="text" onClick={() => setConfirming(false)}>
            {tCommon("cancel")}
          </Button>
        </Stack>
      ) : (
        <Button variant="contained" color="error" onClick={() => setConfirming(true)}>
          {t("deleteAccountButton")}
        </Button>
      )}
    </Stack>
  );
}
