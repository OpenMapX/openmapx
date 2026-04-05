"use client";

import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import { authClient, useSession } from "@openmapx/core";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

export function ImpersonationBanner() {
  const { data: session } = useSession();
  const router = useRouter();
  const [stopping, setStopping] = useState(false);

  const stopImpersonating = useCallback(async () => {
    setStopping(true);
    try {
      await authClient.admin.stopImpersonating();
      router.refresh();
      router.push("/admin/users");
    } catch {
      setStopping(false);
    }
  }, [router]);

  if (!session?.session?.impersonatedBy) return null;

  return (
    <>
      <Alert
        severity="warning"
        icon={<WarningIcon />}
        sx={{
          borderRadius: 0,
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 9999,
          height: 48,
          "& .MuiAlert-message": {
            display: "flex",
            alignItems: "center",
            gap: 1,
            width: "100%",
          },
        }}
        action={
          <Button
            color="inherit"
            size="small"
            variant="outlined"
            disabled={stopping}
            onClick={stopImpersonating}
            sx={{ whiteSpace: "nowrap" }}
          >
            Stop Impersonating
          </Button>
        }
      >
        Impersonating <strong>{session.user.name}</strong> ({session.user.email})
      </Alert>
      {/* Spacer to push page content below the fixed banner */}
      <div style={{ height: 48 }} />
    </>
  );
}
