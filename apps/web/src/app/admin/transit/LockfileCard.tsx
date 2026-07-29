"use client";

import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import RefreshIcon from "@mui/icons-material/Refresh";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useState } from "react";
import { useAdminToast } from "@/components/admin/shared/AdminToast";
import { ConfirmDialog } from "@/components/admin/shared/ConfirmDialog";
import type { TransitStateSummary } from "@/lib/admin/transitHooks";
import { useBumpTransitous } from "@/lib/admin/transitHooks";

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
  const [branch, setBranch] = useState("main");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const bump = useBumpTransitous();
  const showToast = useAdminToast();
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: "center",
          mb: 1.5,
        }}
      >
        {hasLock ? (
          <LockIcon color="primary" fontSize="small" />
        ) : (
          <LockOpenIcon color="disabled" fontSize="small" />
        )}
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
          }}
        >
          Transitous lock
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Chip
          size="small"
          color={hasLock ? "success" : "warning"}
          variant="outlined"
          label={hasLock ? "locked" : "no lockfile"}
        />
        <Button
          size="small"
          variant="outlined"
          startIcon={<RefreshIcon />}
          disabled={bump.isPending || !branch.trim()}
          onClick={() => setConfirmOpen(true)}
        >
          Bump pin
        </Button>
      </Stack>
      {!hasLock && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          No <code>infra/docker/transitous.lock.json</code> found. Run the bump CLI to pin the
          catalog to a specific upstream ref before syncing.
        </Alert>
      )}
      <Stack
        direction="row"
        spacing={3}
        useFlexGap
        sx={{
          flexWrap: "wrap",
        }}
      >
        <Box>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            Ref
          </Typography>
          <Typography
            variant="body2"
            sx={{
              fontFamily: "monospace",
            }}
          >
            {state.transitousRef ?? "—"}
          </Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            Locked at
          </Typography>
          <Typography variant="body2">{formatTime(state.transitousLockedAt)}</Typography>
        </Box>
        <Box>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            Locked by
          </Typography>
          <Typography variant="body2">{state.transitousLockedBy ?? "—"}</Typography>
        </Box>
      </Stack>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          display: "block",
          mt: 1.5,
        }}
      >
        Pin changes are explicit, admin-only, rate-limited, and written to the audit log. Run a
        transit sync after reviewing the new catalog diff.
      </Typography>
      <TextField
        label="Catalog branch"
        value={branch}
        onChange={(event) => setBranch(event.target.value)}
        sx={{ mt: 1.5, maxWidth: 280 }}
      />
      <ConfirmDialog
        open={confirmOpen}
        title="Bump Transitous catalog pin"
        message={`Fetch branch "${branch}" and update the deployment lockfile? This changes the feed catalog used by future transit syncs.`}
        confirmLabel="Bump pin"
        confirmColor="warning"
        loading={bump.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() =>
          bump.mutate(branch.trim(), {
            onSuccess: () => {
              showToast("Transitous pin updated");
              setConfirmOpen(false);
            },
            onError: (error) =>
              showToast(error instanceof Error ? error.message : "Pin update failed", "error"),
          })
        }
      />
    </Paper>
  );
}
