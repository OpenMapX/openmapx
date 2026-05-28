"use client";

import CloseIcon from "@mui/icons-material/Close";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";

interface InstallFromUrlDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: (jobId: string) => void;
}

export function InstallFromUrlDialog({ open, onClose, onSuccess }: InstallFromUrlDialogProps) {
  const { apiUrl } = useEnv();
  const qc = useQueryClient();
  const [artifactUrl, setArtifactUrl] = useState("");
  const [version, setVersion] = useState("");
  const [sha256, setSha256] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/install`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactUrl: artifactUrl.trim(),
          version: version.trim() || undefined,
          sha256: sha256.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Install failed");
      }
      return res.json() as Promise<{ jobId: string }>;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["store-catalog"] });
      qc.invalidateQueries({ queryKey: ["store-installed"] });
      onSuccess?.(data.jobId);
      handleClose();
    },
    onError: (err) => setError(String(err)),
  });

  const handleClose = () => {
    setArtifactUrl("");
    setVersion("");
    setSha256("");
    setError(null);
    mutation.reset();
    onClose();
  };

  const trimmed = artifactUrl.trim();
  const valid = (() => {
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "https:" && parsed.pathname.endsWith(".tar.gz");
    } catch {
      return false;
    }
  })();

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          Install from artifact URL
          <IconButton size="small" onClick={handleClose}>
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 2,
          }}
        >
          Install a community integration from a prebuilt <code>.tar.gz</code> artifact built with
          the OpenMapX CLI (<code>pnpm openmapx integrations package</code>). Source installs from
          Git are a developer workflow — use the CLI on a checked-out repo.
        </Typography>

        <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
          Only install integrations from authors you trust. Backend code in the artifact runs
          in-process inside the API server.
        </Alert>

        <TextField
          label="Artifact URL"
          placeholder="https://github.com/username/repo/releases/download/v1.0.0/integration.tar.gz"
          value={artifactUrl}
          onChange={(e) => setArtifactUrl(e.target.value)}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          helperText="HTTPS URL to a prebuilt .tar.gz artifact"
        />

        <TextField
          label="Version label (optional)"
          placeholder="v1.0.0"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          helperText="Recorded as the installed version"
        />

        <TextField
          label="SHA-256 (recommended)"
          placeholder="64-character checksum"
          value={sha256}
          onChange={(e) => setSha256(e.target.value)}
          fullWidth
          size="small"
          helperText="Verified before extraction"
        />

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={handleClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => mutation.mutate()}
          disabled={!valid || mutation.isPending}
        >
          {mutation.isPending ? "Queuing…" : "Install"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
