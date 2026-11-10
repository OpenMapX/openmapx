"use client";

import Snackbar from "@mui/material/Snackbar";
import { useTranslations } from "next-intl";
import { useNativeEndFailure } from "@/lib/mobile/nativeEndFailure";

/**
 * Says that ending a native trip failed: either native refused and guidance is
 * still running, or native did not answer and the trip may not have ended.
 * Keyed by the failure, so each failure shows a fresh notice.
 */
export function NavigationEndFailureNotice() {
  const t = useTranslations("navigation");
  const failure = useNativeEndFailure((state) => state.failure);
  const dismiss = useNativeEndFailure((state) => state.dismiss);
  return (
    <Snackbar
      key={failure?.id ?? 0}
      open={failure !== null}
      message={failure?.kind === "unconfirmed" ? t("endUnconfirmed") : t("endFailed")}
      autoHideDuration={6000}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") dismiss();
      }}
    />
  );
}
