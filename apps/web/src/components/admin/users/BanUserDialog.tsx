"use client";

import Button from "@mui/material/Button";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useTranslations } from "next-intl";
import { useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAccountAction } from "@/lib/admin/accountAdmin";
import { useAccountErrorText } from "@/lib/admin/useAccountErrorText";
import { useAdminToast } from "../shared/AdminToast";

interface BanUserDialogProps {
  user: { id: string; name: string };
  onClose: () => void;
}

export function BanUserDialog({ user, onClose }: BanUserDialogProps) {
  const t = useTranslations("adminUsers");
  const tCommon = useTranslations("common");
  const showToast = useAdminToast();
  const errorText = useAccountErrorText();
  const [reason, setReason] = useState("");

  const ban = useAccountAction(user.id, {
    onSuccess: () => {
      showToast(t("nameHasBeenBanned", { name: user.name }));
      onClose();
    },
    onError: (error) => showToast(errorText(error), "error"),
  });
  const close = () => {
    ban.invalidateOwner();
    onClose();
  };

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>{t("banName", { name: user.name })}</DialogTitle>
      <DialogContent>
        <DialogContentText
          sx={{
            mb: 2,
          }}
        >
          {t("theUserWillBePrevented")}
        </DialogContentText>
        <TextField
          disabled={ban.isPending}
          label={t("reasonOptional")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          size="small"
          fullWidth
          multiline
          rows={2}
        />
        {ban.error && (
          <span style={{ color: "red", fontSize: 13, display: "block", marginTop: 8 }}>
            {errorText(ban.error)}
          </span>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={ban.isPending}>
          {tCommon("cancel")}
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={ban.isPending}
          onClick={() => ban.mutate((client) => client.ban(user.id, reason.trim() || undefined))}
        >
          {t("banUser")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
