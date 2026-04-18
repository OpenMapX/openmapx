"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import { type Review, useSubmitReview } from "@openmapx/core";
import { useTranslations } from "next-intl";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The review to delete. Must belong to the signed-in user. */
  review: Review;
  /** Subject of the place the review belongs to — passed through so cache
   *  invalidation on success targets the right reviews list. */
  subject: { lat: number; lng: number; name: string; osmId?: string };
}

export function DeleteReviewDialog({ open, onClose, review, subject }: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const submit = useSubmitReview();

  async function handleConfirm() {
    await submit.mutateAsync({
      subject,
      action: "delete",
      editTargetId: review.id,
    });
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("deleteReview")}</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: 1 }}>{t("deleteReviewConfirm")}</DialogContentText>
        {review.opinion && (
          <DialogContentText
            variant="body2"
            sx={{
              fontStyle: "italic",
              borderLeft: 3,
              borderColor: "divider",
              pl: 1.5,
              py: 0.5,
              mt: 1,
            }}
          >
            {review.opinion.slice(0, 160)}
            {review.opinion.length > 160 ? "…" : ""}
          </DialogContentText>
        )}
        {submit.isError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {submit.error instanceof Error ? submit.error.message : "Delete failed"}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit" disabled={submit.isPending}>
          {tc("cancel")}
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={submit.isPending}
          color="error"
          variant="contained"
          startIcon={submit.isPending ? <CircularProgress size={16} /> : null}
        >
          {t("deleteReview")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
