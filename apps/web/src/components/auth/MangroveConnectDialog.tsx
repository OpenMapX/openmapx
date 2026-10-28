"use client";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import KeyOutlinedIcon from "@mui/icons-material/KeyOutlined";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useKeypairStore, useMangroveSigner } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
export function MangroveConnectDialog({
  open,
  onClose,
  onLocal,
  beforeLogin,
}: {
  open: boolean;
  onClose: () => void;
  onLocal: () => void;
  beforeLogin?: () => void;
}) {
  const t = useTranslations("account"),
    tc = useTranslations("common");
  const signer = useMangroveSigner();
  const fullScreen = useFullScreenOnMobile();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [handle, setHandle] = useState("");
  async function login(provider: "osm" | "passkey" | "bluesky") {
    if (!signer.controller) return;
    setBusy(true);
    setError(false);
    try {
      beforeLogin?.();
      useKeypairStore.getState().lock();
      const target = await signer.controller.beginLogin(
        provider,
        window.location.pathname + window.location.search + window.location.hash,
        handle,
      );
      window.location.assign(target);
    } catch {
      setError(true);
      setBusy(false);
    }
  }
  const unavailable = !signer.config?.configured;
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle>{t("mangroveConnectTitle")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t("mangroveConnectIntro")}
          </Typography>
          {unavailable && (
            <Alert
              severity="info"
              action={
                <Button
                  color="inherit"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void signer.controller
                      ?.restore()
                      .catch(() => setError(true))
                      .finally(() => setBusy(false));
                  }}
                >
                  {tc("retry")}
                </Button>
              }
            >
              {t("mangroveSignerUnavailable")}
            </Alert>
          )}
          {error && <Alert severity="error">{t("mangroveConnectFailed")}</Alert>}
          <Button
            variant="contained"
            size="large"
            startIcon={<FingerprintIcon />}
            disabled={busy || unavailable}
            onClick={() => void login("passkey")}
          >
            {t("mangroveLoginPasskey")}
          </Button>
          <Button
            variant="outlined"
            size="large"
            startIcon={<MapOutlinedIcon />}
            disabled={busy || unavailable}
            onClick={() => void login("osm")}
          >
            {t("mangroveLoginOsm")}
          </Button>
          <Button
            variant="outlined"
            size="large"
            disabled={busy || unavailable}
            onClick={() => void login("bluesky")}
          >
            {t("mangroveLoginBluesky")}
          </Button>
          <TextField
            size="small"
            label={t("mangroveBlueskyHandle")}
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            disabled={busy || unavailable}
            slotProps={{ htmlInput: { maxLength: 253 } }}
            helperText={t("mangroveBlueskyHandleHelp")}
          />
          <Typography variant="caption" color="text.secondary">
            {t("mangroveSignerCustody")}
          </Typography>
          <Divider />
          <Button
            startIcon={<KeyOutlinedIcon />}
            disabled={busy}
            onClick={() => {
              signer.controller?.selectLocal();
              useKeypairStore.getState().lock();
              onLocal();
            }}
          >
            {t("mangroveUseLocal")}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {t("mangroveLocalExplanation")}
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button color="inherit" onClick={onClose} disabled={busy}>
          {tc("cancel")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
