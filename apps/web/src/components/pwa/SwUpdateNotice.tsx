"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import { useNavigationStore } from "@openmapx/core";
import type { Serwist } from "@serwist/window";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
  hasActiveAreaDownload,
  hasUnsavedTextEntry,
  isSafeToAutoReload,
  markAutoReloaded,
  msSinceLastAutoReload,
} from "@/lib/swAutoUpdate";

const BANNER_GRACE_MS = 30_000;

export function SwUpdateNotice() {
  const t = useTranslations("pwa");
  const queryClient = useQueryClient();
  const [updateReady, setUpdateReady] = useState(false);
  const [visible, setVisible] = useState(true);
  const [graceElapsed, setGraceElapsed] = useState(false);
  const swRef = useRef<Serwist | null>(null);
  const updateReadyRef = useRef(false);

  useEffect(() => {
    setVisible(document.visibilityState === "visible");
  }, []);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const handleVisibilityChange = () => {
      setVisible(document.visibilityState === "visible");
      attemptAutoApply();
    };

    const handleOnline = () => {
      attemptAutoApply();
    };

    const attemptAutoApply = () => {
      if (!updateReadyRef.current) return;
      if (document.visibilityState !== "hidden") return;
      const safe = isSafeToAutoReload({
        online: navigator.onLine,
        navStatus: useNavigationStore.getState().status,
        mutationCount: queryClient.isMutating(),
        hasActiveDownload: hasActiveAreaDownload(),
        hasUnsavedText: hasUnsavedTextEntry(),
        msSinceLastAutoReload: msSinceLastAutoReload(),
      });
      if (!safe) return;
      markAutoReloaded();
      swRef.current?.messageSkipWaiting();
    };

    void import("@serwist/window").then((mod) => {
      if (cancelled) return;
      const sw = new mod.Serwist("/sw.js", { scope: "/" });

      sw.addEventListener("waiting", () => {
        updateReadyRef.current = true;
        setUpdateReady(true);
        graceTimer = setTimeout(() => setGraceElapsed(true), BANNER_GRACE_MS);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        window.addEventListener("online", handleOnline);
        attemptAutoApply();
      });

      sw.addEventListener("controlling", (event) => {
        // sw.ts uses `clientsClaim: true`, so this event ALSO fires on first
        // install (a new SW claiming a page that previously had no
        // controller). Reloading there yanks the rug out from under a
        // first-time visitor for no reason. `isUpdate` is true only when
        // the new SW replaced an existing one — i.e. the case where the
        // page genuinely needs a refresh to pick up new bundles.
        if (event.isUpdate) {
          window.location.reload();
        }
      });

      swRef.current = sw;
      sw.register().catch((err) => console.warn("SW registration failed:", err));
    });

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
      if (graceTimer !== null) clearTimeout(graceTimer);
    };
  }, [queryClient]);

  const handleReload = () => {
    const sw = swRef.current;
    if (!sw) {
      window.location.reload();
      return;
    }
    sw.messageSkipWaiting();
  };

  return (
    <Snackbar
      open={updateReady && visible && graceElapsed}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      sx={{ zIndex: 1500, mb: "var(--omx-safe-bottom)" }}
    >
      <Alert
        severity="info"
        variant="filled"
        action={
          <Button color="inherit" size="small" onClick={handleReload}>
            {t("reload")}
          </Button>
        }
        sx={{
          width: "100%",
          bgcolor: "primary.main",
          color: "primary.contrastText",
          "& .MuiAlert-icon": { color: "inherit" },
        }}
      >
        {t("updateAvailable")}
      </Alert>
    </Snackbar>
  );
}
