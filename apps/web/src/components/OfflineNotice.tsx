"use client";

import Alert from "@mui/material/Alert";
import Snackbar from "@mui/material/Snackbar";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

export function OfflineNotice() {
  const t = useTranslations("offline");
  const [isOffline, setIsOffline] = useState(false);
  const [showOnline, setShowOnline] = useState(false);

  useEffect(() => {
    // Sync with actual connectivity on mount (navigator.onLine is not reactive)
    setIsOffline(!navigator.onLine);

    const handleOffline = () => {
      setIsOffline(true);
      setShowOnline(false);
    };
    const handleOnline = () => {
      setIsOffline(false);
      setShowOnline(true);
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return (
    <>
      {/* Persistent offline notice — no auto-hide */}
      <Snackbar
        open={isOffline}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ zIndex: 1400 }}
      >
        <Alert severity="warning" variant="filled" sx={{ width: "100%" }}>
          {t("youreOffline")}
        </Alert>
      </Snackbar>

      {/* Transient back-online notice — auto-hides after 3s */}
      <Snackbar
        open={showOnline}
        autoHideDuration={3000}
        onClose={() => setShowOnline(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        sx={{ zIndex: 1400 }}
      >
        <Alert severity="success" variant="filled" sx={{ width: "100%" }}>
          {t("backOnline")}
        </Alert>
      </Snackbar>
    </>
  );
}
