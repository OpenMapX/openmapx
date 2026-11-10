"use client";

import Snackbar from "@mui/material/Snackbar";
import { useTranslations } from "next-intl";
import { useNativeEndFailure } from "@/lib/mobile/nativeEndFailure";

/** Says that ending a native trip failed and guidance is still running. */
export function NavigationEndFailureNotice() {
  const t = useTranslations("navigation");
  const failed = useNativeEndFailure((state) => state.failed);
  const dismiss = useNativeEndFailure((state) => state.dismiss);
  return (
    <Snackbar
      open={failed}
      message={t("endFailed")}
      autoHideDuration={6000}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") dismiss();
      }}
    />
  );
}
