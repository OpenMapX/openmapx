"use client";

import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";

export function OfflineActions({
  retryLabel,
  openMapLabel,
}: {
  retryLabel: string;
  openMapLabel: string;
}) {
  // We deliberately use full document navigations instead of next/navigation's
  // router.push / router.refresh. Those trigger client-side App Router
  // transitions that fetch an RSC payload — that request isn't a navigation
  // (request.mode !== "navigate") so it bypasses the SW navigation handler
  // that serves the precached `/` from app-shell-v1. Offline, the RSC fetch
  // hangs and these buttons would be useless.
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} justifyContent="center">
      <Button variant="contained" onClick={() => window.location.reload()}>
        {retryLabel}
      </Button>
      <Button variant="outlined" component="a" href="/">
        {openMapLabel}
      </Button>
    </Stack>
  );
}
