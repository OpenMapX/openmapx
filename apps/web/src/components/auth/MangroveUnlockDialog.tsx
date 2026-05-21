"use client";

import FingerprintIcon from "@mui/icons-material/Fingerprint";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { type KeypairEnvelope, useKeypairState, useUnlockKeypair } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onUnlocked?: () => void;
  rpId?: string;
}

export function MangroveUnlockDialog({ open, onClose, onUnlocked, rpId }: Props) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const unlock = useUnlockKeypair();
  const state = useKeypairState();
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);

  const envelope = state.data?.state === "ready" ? (state.data as KeypairEnvelope) : null;
  const encrypted = envelope?.mode === "encrypted" ? envelope : null;
  const hasPassphrase = !!encrypted?.wraps.some((w) => w.wrapType === "passphrase");
  const hasWebAuthn = !!encrypted?.wraps.some((w) => w.wrapType === "webauthn");

  async function handleUnlockPassphrase() {
    setError(null);
    try {
      await unlock.mutateAsync({ method: "passphrase", passphrase });
      setPassphrase("");
      onUnlocked?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mangroveUnlockFailed"));
    }
  }

  async function handleUnlockPasskey() {
    setError(null);
    try {
      await unlock.mutateAsync({ method: "webauthn", rpId });
      onUnlocked?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mangroveUnlockFailed"));
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("mangroveUnlockTitle")}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("mangroveUnlockIntro")}
        </Typography>

        {hasWebAuthn && (
          <Box sx={{ mb: 1.5 }}>
            <Button
              fullWidth
              variant="contained"
              size="large"
              startIcon={unlock.isPending ? <CircularProgress size={16} /> : <FingerprintIcon />}
              onClick={handleUnlockPasskey}
              disabled={unlock.isPending}
            >
              {t("mangroveUnlockWithPasskey")}
            </Button>
          </Box>
        )}

        {hasPassphrase && hasWebAuthn && (
          <Divider sx={{ my: 2 }}>
            <Typography variant="caption" color="text.secondary">
              {tc("or")}
            </Typography>
          </Divider>
        )}

        {hasPassphrase && (
          <TextField
            type="password"
            label={t("mangrovePassphraseLabel")}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            autoComplete="current-password"
            fullWidth
            onKeyDown={(e) => {
              if (e.key === "Enter" && passphrase && !unlock.isPending) {
                void handleUnlockPassphrase();
              }
            }}
            helperText={t("mangrovePassphraseHelperUnlock")}
          />
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={unlock.isPending}>
          {tc("cancel")}
        </Button>
        {hasPassphrase && (
          <Button
            variant="contained"
            onClick={handleUnlockPassphrase}
            disabled={!passphrase || unlock.isPending}
            startIcon={unlock.isPending ? <CircularProgress size={16} /> : <LockOpenIcon />}
          >
            {t("mangroveUnlockCta")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
