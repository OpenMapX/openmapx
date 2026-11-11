"use client";

import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Portal from "@mui/material/Portal";
import Snackbar from "@mui/material/Snackbar";
import { isErrorShownByCaller, refreshSession } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { type MutationErrorMessage, mutationErrorMessage } from "@/lib/mutationErrorMessage";
import { useAuthPromptStore } from "@/stores/authPromptStore";

interface Notice {
  id: number;
  message: MutationErrorMessage;
}

/**
 * Tells the user when a change they made did not go through. Every failed
 * mutation reaches this notice unless its caller shows the failure itself
 * (`CALLER_SHOWS_ERRORS`). Administration pages report their own failures
 * with toasts and error states, so the notice stays silent there.
 *
 * Mount it outside the session authority boundary: a refused session refreshes
 * the session, which remounts everything inside that boundary.
 */
export function MutationErrorNotice() {
  const queryClient = useQueryClient();
  const t = useTranslations();
  const pathname = usePathname();
  const onAdminPage = pathname?.startsWith("/admin") ?? false;
  const showAuthPrompt = useAuthPromptStore((state) => state.show);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (onAdminPage) return;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (isErrorShownByCaller(event.mutation.options.meta)) return;
      const message = mutationErrorMessage(event.action.error);
      if (!message) return;
      // The API no longer accepts this session; stop presenting the user as signed in.
      if ("action" in message && message.action === "signIn") refreshSession();
      setNotice((current) =>
        current && sameMessage(current.message, message)
          ? current
          : { id: (current?.id ?? 0) + 1, message },
      );
      setOpen(true);
    });
  }, [queryClient, onAdminPage]);

  if (!notice) return null;

  const close = (_event?: unknown, reason?: string) => {
    if (reason !== "clickaway") setOpen(false);
  };
  const { namespace, key, values } = notice.message;
  const signIn = "action" in notice.message && notice.message.action === "signIn";

  // An open dialog hides the page's existing nodes from assistive technology.
  // Each notice gets a fresh node at the end of the document, so a failure
  // reported while a dialog is open is still announced.
  return (
    <Portal key={notice.id}>
      <Snackbar
        open={open}
        // A notice that offers a way forward stays until the user acts on it.
        autoHideDuration={signIn ? null : 6000}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        slotProps={{ transition: { onExited: () => setNotice(null) } }}
        sx={{ zIndex: 1400, mb: "var(--omx-safe-bottom)" }}
      >
        <Alert
          severity="error"
          variant="filled"
          action={
            <>
              {signIn && (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    setOpen(false);
                    showAuthPrompt();
                  }}
                >
                  {t("auth.signIn")}
                </Button>
              )}
              <IconButton
                color="inherit"
                size="small"
                aria-label={t("common.close")}
                onClick={() => setOpen(false)}
              >
                <CloseIcon fontSize="small" />
              </IconButton>
            </>
          }
          sx={{ width: "100%", alignItems: "center" }}
        >
          {t(`${namespace}.${key}`, values)}
        </Alert>
      </Snackbar>
    </Portal>
  );
}

function sameMessage(a: MutationErrorMessage, b: MutationErrorMessage): boolean {
  return a.namespace === b.namespace && a.key === b.key;
}
