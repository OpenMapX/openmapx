"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { useTranslations } from "next-intl";

interface NlpConsentDialogProps {
  open: boolean;
  providers: string[];
  onAccept: () => void;
  onDecline: () => void;
}

export function NlpConsentDialog({ open, providers, onAccept, onDecline }: NlpConsentDialogProps) {
  const t = useTranslations("search");
  const providerLabel = providers.join(", ");

  // No onClose prop — the dialog is a consent gate that requires an explicit choice.
  return (
    <Dialog open={open} maxWidth="xs" fullWidth>
      <DialogTitle>{t("nlpConsentTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("nlpConsentBody", { provider: providerLabel })}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onDecline} color="inherit">
          {t("noThanks")}
        </Button>
        <Button onClick={onAccept} variant="contained">
          {t("enable")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
