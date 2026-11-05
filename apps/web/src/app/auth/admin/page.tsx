"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { useCallback, useEffect, useRef, useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { useAccountAdmin } from "@/lib/admin/accountAdmin";
import { completeStoredAdminReauthentication } from "@/lib/admin/adminReauthentication";
export default function AdminSignInPage() {
  const { apiUrl, actorId } = useAccountAdmin(),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false),
    key = JSON.stringify([apiUrl, actorId]),
    owner = useRef({ key, mounted: true });
  owner.current.key = key;
  useEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
    };
  }, []);
  const complete = useCallback(async () => {
    const origin = apiUrl,
      identity = key;
    setBusy(true);
    setError(false);
    try {
      const path = await completeStoredAdminReauthentication(origin);
      if (owner.current.mounted && owner.current.key === identity) window.location.assign(path);
    } catch {
      if (owner.current.mounted && owner.current.key === identity) {
        setError(true);
        setBusy(false);
      }
    }
  }, [apiUrl, key]);
  const resumed = useRef("");
  useEffect(() => {
    if (
      actorId &&
      resumed.current !== key &&
      new URLSearchParams(window.location.search).get("complete") === "1"
    ) {
      resumed.current = key;
      void complete();
    }
  }, [actorId, complete, key]);
  return (
    <Box>
      {error && (
        <Alert
          severity="error"
          sx={{ position: "fixed", top: 16, left: 16, right: 16, zIndex: 2000 }}
        >
          This sign-in could not authorize the action. Sign in with the same administrator account,
          or cancel and start a new confirmation.
        </Alert>
      )}
      {!busy && (
        <AuthDialog
          open
          dismissible={false}
          callbackPath="/auth/admin?complete=1"
          onAuthenticated={() => window.location.assign("/auth/admin?complete=1")}
          onClose={() => window.location.assign("/admin")}
        />
      )}
    </Box>
  );
}
