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
  const [url, setUrl] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/store/install`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository: url.trim(),
          version: version.trim() || undefined,
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
    setUrl("");
    setVersion("");
    setError(null);
    mutation.reset();
    onClose();
  };

  const valid = url.trim().startsWith("https://github.com/");

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          Install from URL
          <IconButton size="small" onClick={handleClose}>
            <CloseIcon />
          </IconButton>
        </Box>
      </DialogTitle>

      <DialogContent>
        <Typography variant="body2" color="text.secondary" mb={2}>
          Install a community integration directly from a GitHub repository. The quality will be
          shown as <strong>Community</strong> (unverified).
        </Typography>

        <Alert severity="warning" sx={{ mb: 2 }} icon={false}>
          Only install integrations from repositories you trust. Community integrations run
          server-side code in the API process.
        </Alert>

        <TextField
          label="GitHub URL"
          placeholder="https://github.com/username/openmapx-my-integration"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          helperText="Must be a valid GitHub repository URL"
        />

        <TextField
          label="Version / tag (optional)"
          placeholder="v1.0.0"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          fullWidth
          size="small"
          helperText="Leave blank to install the latest default branch"
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
