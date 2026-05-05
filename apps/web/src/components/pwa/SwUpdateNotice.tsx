"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import type { Serwist } from "@serwist/window";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

export function SwUpdateNotice() {
  const t = useTranslations("pwa");
  const [updateReady, setUpdateReady] = useState(false);
  const swRef = useRef<Serwist | null>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    let cancelled = false;

    void import("@serwist/window").then((mod) => {
      if (cancelled) return;
      const sw = new mod.Serwist("/sw.js", { scope: "/" });

      sw.addEventListener("waiting", () => {
        setUpdateReady(true);
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
    };
  }, []);

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
      open={updateReady}
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
        sx={{ width: "100%" }}
      >
        {t("updateAvailable")}
      </Alert>
    </Snackbar>
  );
}
