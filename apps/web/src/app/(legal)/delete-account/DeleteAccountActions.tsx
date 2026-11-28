"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { authClient, useSession } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import {
  type CredentialRefusal,
  credentialRefusal,
  FreshSignInPrompt,
} from "@/components/auth/freshSignIn";
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
  const [cleanupIncomplete, setCleanupIncomplete] = useState(false);
  // A deletion refused for an old sign-in or an impersonation session explains
  // that instead of the generic failure. A recent sign-in is the confirmation
  // for every kind of account, so no password is asked for.
  const [refusal, setRefusal] = useState<CredentialRefusal | "extension" | null>(null);

  const remove = useCallback(async () => {
    setState("working");
    setRefusal(null);
    try {
      const { error } = await authClient.deleteUser({});
      if (error) {
        // An installed extension's database key refused the deletion; the
        // account is unchanged and the administrator has been told.
        setRefusal(
          (error as { code?: unknown }).code === "EXTENSION_BLOCKS_ACCOUNT_DELETION"
            ? "extension"
            : credentialRefusal(error),
        );
        setState("error");
        return;
      }
      const { failures } = await clearPrivateDeviceData({ queryClient });
      setCleanupIncomplete(failures > 0);
      setState("done");
    } catch {
      setState("error");
    }
  }, [queryClient]);

  if (isPending) return null;

  if (state === "done") {
    return (
      <Stack spacing={2}>
        <Alert severity="success" role="status">
          {t("deleteAccountTimingBody")}
        </Alert>
        {cleanupIncomplete && (
          <Alert severity="warning">{tAccount("deviceCleanupIncomplete")}</Alert>
        )}
      </Stack>
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
      {state === "error" &&
        (refusal === "sign-in" ? (
          <FreshSignInPrompt returnPath="/delete-account" />
        ) : (
          <Alert severity="error" role="alert">
            {refusal === "impersonating"
              ? tAccount("freshSignIn.impersonating")
              : refusal === "extension"
                ? tAccount("deletionBlockedByExtension")
                : tAccount("failedDeleteAccount")}
          </Alert>
        ))}
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
