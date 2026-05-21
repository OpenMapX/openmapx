"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import type { Review } from "@openmapx/core";
import { useSubmitReview, useUserKeypair } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  review: Review;
}

export function ReportAbuseDialog({ open, onClose, review }: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const submit = useSubmitReview();
  const { keypair, isLoading: keypairLoading } = useUserKeypair();
  const [reason, setReason] = useState("");

  async function handleConfirm() {
    if (!keypair) return;
    await submit.mutateAsync({
      subject: review.subject,
      action: "report_abuse",
      editTargetId: review.id,
      opinion: reason.trim() || undefined,
      stars: undefined,
    });
    setReason("");
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("reportReview")}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 2 }}>
          {review.opinion?.slice(0, 140) ?? review.stars?.toString()}
        </DialogContentText>
        <TextField
          label={t("reportReason")}
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 280))}
          multiline
          rows={3}
          fullWidth
        />
        {submit.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {submit.error instanceof Error ? submit.error.message : "Report failed"}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          {tc("cancel")}
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={submit.isPending || !keypair || keypairLoading}
          color="error"
          variant="contained"
        >
          {tc("confirm")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
