"use client";

import Alert from "@mui/material/Alert";
import Portal from "@mui/material/Portal";
import Snackbar from "@mui/material/Snackbar";
import { isErrorShownByCaller } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { type MutationErrorMessage, mutationErrorMessage } from "@/lib/mutationErrorMessage";

interface Notice {
  id: number;
  message: MutationErrorMessage;
}

/**
 * Tells the user when a change they made did not go through. Every failed
 * mutation reaches this notice unless its caller shows the failure itself
 * (`CALLER_SHOWS_ERRORS`). Administration pages report their own failures
 * with toasts and error states, so the notice stays silent there.
 */
export function MutationErrorNotice() {
  const queryClient = useQueryClient();
  const t = useTranslations();
  const pathname = usePathname();
  const onAdminPage = pathname?.startsWith("/admin") ?? false;
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (onAdminPage) return;
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (isErrorShownByCaller(event.mutation.options.meta)) return;
      const message = mutationErrorMessage(event.action.error);
      if (!message) return;
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

  // An open dialog hides the page's existing nodes from assistive technology.
  // Each notice gets a fresh node at the end of the document, so a failure
  // reported while a dialog is open is still announced.
  return (
    <Portal key={notice.id}>
      <Snackbar
        open={open}
        autoHideDuration={6000}
        onClose={close}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        slotProps={{ transition: { onExited: () => setNotice(null) } }}
        sx={{ zIndex: 1400, mb: "var(--omx-safe-bottom)" }}
      >
        <Alert
          severity="error"
          variant="filled"
          onClose={close}
          closeText={t("common.close")}
          sx={{ width: "100%" }}
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
