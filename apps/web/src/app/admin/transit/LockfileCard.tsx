"use client";

import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { TransitStateSummary } from "@/lib/admin/transitHooks";

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function LockfileCard({ state }: { state: TransitStateSummary }) {
  const hasLock = !!state.transitousRef;
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} mb={1.5}>
        {hasLock ? (
          <LockIcon color="primary" fontSize="small" />
        ) : (
          <LockOpenIcon color="disabled" fontSize="small" />
        )}
        <Typography variant="subtitle1" fontWeight={700}>
          Transitous lock
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Chip
          size="small"
          color={hasLock ? "success" : "warning"}
          variant="outlined"
          label={hasLock ? "locked" : "no lockfile"}
        />
      </Stack>

      {!hasLock && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          No <code>infra/docker/transitous.lock.json</code> found. Run the bump CLI to pin the
          catalog to a specific upstream ref before syncing.
        </Alert>
      )}

      <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Ref
          </Typography>
          <Typography variant="body2" fontFamily="monospace">
            {state.transitousRef ?? "—"}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Locked at
          </Typography>
          <Typography variant="body2">{formatTime(state.transitousLockedAt)}</Typography>
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            Locked by
          </Typography>
          <Typography variant="body2">{state.transitousLockedBy ?? "—"}</Typography>
        </Box>
      </Stack>

      <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
        Bumping the ref is CLI-driven for an explicit audit trail. The web admin shows current lock
        state only.
      </Typography>
    </Paper>
  );
}
