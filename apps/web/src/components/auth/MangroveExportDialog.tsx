"use client";

import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { toMangroveExportJwk } from "@openmapx/mangrove-client";
import { useMangroveKeypairExport } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function MangroveExportDialog({ open, onClose }: Props) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const fullScreen = useFullScreenOnMobile();
  const { privateJwk, reason } = useMangroveKeypairExport();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  // Reset reveal state each time the dialog opens so reopening never
  // accidentally surfaces the secret.
  if (!open && revealed) setRevealed(false);
  if (!open && copied) setCopied(false);

  // Decorated with the `alg`/`ext`/`key_ops`/`metadata` fields that
  // mangrove.reviews' importer requires — otherwise they reject the JWK
  // with "does not contain the required metadata field".
  const exportJwk = privateJwk ? toMangroveExportJwk(privateJwk) : null;
  const jwkDisplay = exportJwk ? JSON.stringify(exportJwk, null, 2) : "";
  const jwkCompact = exportJwk ? JSON.stringify(exportJwk) : "";

  async function handleCopy() {
    if (!jwkCompact) return;
    await navigator.clipboard.writeText(jwkCompact);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleDownload() {
    if (!jwkCompact) return;
    const blob = new Blob([jwkCompact], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mangrove-keypair-${new Date().toISOString().slice(0, 10)}.jwk.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      PaperProps={{ sx: mobileFullScreenDialogPaperSx }}
    >
      <DialogTitle>{t("mangroveExportTitle")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t("mangroveExportHelp")}
          </Typography>

          <Alert severity="warning" icon={<WarningAmberIcon />}>
            {t("mangroveExportWarning")}
          </Alert>

          {reason === "locked" && <Alert severity="info">{t("mangroveMustUnlockFirst")}</Alert>}
          {reason === "noEnvelope" && <Alert severity="error">{t("mangroveExportFailed")}</Alert>}

          {privateJwk && (
            <Box
              sx={{
                position: "relative",
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                bgcolor: "action.hover",
                minHeight: 120,
                overflow: "hidden",
              }}
            >
              {/* Blur is applied only to this inner content box. The toggle
                  button is a sibling (not a child) so it stays crisp — CSS
                  filters cascade into descendants and there's no escape. */}
              <Box
                sx={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  p: 1.5,
                  pr: 5,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  userSelect: revealed ? "text" : "none",
                  filter: revealed ? "none" : "blur(5px)",
                  transition: "filter 120ms",
                }}
              >
                {jwkDisplay}
              </Box>
              <IconButton
                size="small"
                onClick={() => setRevealed((r) => !r)}
                sx={{ position: "absolute", top: 4, right: 4 }}
                aria-label={revealed ? t("mangroveExportHide") : t("mangroveExportShow")}
              >
                {revealed ? (
                  <VisibilityOffIcon fontSize="small" />
                ) : (
                  <VisibilityIcon fontSize="small" />
                )}
              </IconButton>
            </Box>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: "wrap", gap: 1 }}>
        <Button onClick={onClose} color="inherit">
          {tc("close")}
        </Button>
        <Button onClick={handleDownload} disabled={!privateJwk} startIcon={<DownloadIcon />}>
          {t("mangroveExportDownload")}
        </Button>
        <Button
          onClick={handleCopy}
          disabled={!privateJwk}
          variant="contained"
          startIcon={<ContentCopyIcon />}
        >
          {copied ? tc("copied") : tc("copy")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
