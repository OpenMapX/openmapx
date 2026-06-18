"use client";

import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { CredentialSetup } from "@openmapx/integration-framework";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useEnv } from "@/lib/EnvProvider";
import { CredentialSetupGuide } from "./CredentialSetupGuide";

interface SetCredentialDialogProps {
  open: boolean;
  onClose: () => void;
  integrationId: string;
  credentialKey: string;
  title: string;
  description?: string;
  setup?: CredentialSetup;
}

export function SetCredentialDialog({
  open,
  onClose,
  integrationId,
  credentialKey,
  title,
  description,
  setup,
}: SetCredentialDialogProps) {
  const env = useEnv();
  const apiUrl = env.apiUrl;
  const qc = useQueryClient();

  const [value, setValue] = useState("");
  const [showValue, setShowValue] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${apiUrl}/api/admin/credentials/${integrationId}/${credentialKey}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string })?.error ?? "Failed to save credential");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "integrations", integrationId] });
      setValue("");
      setShowValue(false);
      setError(null);
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to save credential");
    },
  });

  function handleClose() {
    if (mutation.isPending) return;
    setValue("");
    setShowValue(false);
    setError(null);
    onClose();
  }

  function handleSave() {
    if (!value.trim()) {
      setError("Value cannot be empty");
      return;
    }
    setError(null);
    mutation.mutate();
  }

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Set Credential — {title}</DialogTitle>
      <DialogContent>
        <Stack
          sx={{
            gap: 2,
            pt: 1,
          }}
        >
          {description && (
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {description}
            </Typography>
          )}
          {setup && <CredentialSetupGuide setup={setup} defaultExpanded />}
          <TextField
            label={title}
            type={showValue ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={mutation.isPending}
            error={!!error}
            helperText={error}
            autoComplete="new-password"
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton
                      onClick={() => setShowValue((v) => !v)}
                      edge="end"
                      size="small"
                      tabIndex={-1}
                    >
                      {showValue ? (
                        <VisibilityOffIcon fontSize="small" />
                      ) : (
                        <VisibilityIcon fontSize="small" />
                      )}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            }}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={mutation.isPending || !value.trim()}
          startIcon={mutation.isPending ? <CircularProgress size={14} /> : undefined}
        >
          Save Credential
        </Button>
      </DialogActions>
    </Dialog>
  );
}
