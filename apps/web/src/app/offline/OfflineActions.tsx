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
  // Deliberately use full document navigations. The service worker retries the
  // requested document from the network and, while still offline, returns only
  // the distinct static `/offline` fallback; it never replays cached map HTML.
  return (
    <Stack
      direction={{ xs: "column", sm: "row" }}
      spacing={1.5}
      sx={{
        justifyContent: "center",
      }}
    >
      <Button variant="contained" onClick={() => window.location.reload()}>
        {retryLabel}
      </Button>
      <Button variant="outlined" component="a" href="/">
        {openMapLabel}
      </Button>
    </Stack>
  );
}
