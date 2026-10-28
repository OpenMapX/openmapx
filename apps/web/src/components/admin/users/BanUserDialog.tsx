"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useAccountAction } from "@/lib/admin/accountAdmin";
import { useAdminToast } from "../shared/AdminToast";

interface BanUserDialogProps {
  user: { id: string; name: string };
  onClose: () => void;
}

export function BanUserDialog({ user, onClose }: BanUserDialogProps) {
  const showToast = useAdminToast();
  const [reason, setReason] = useState("");

  const ban = useAccountAction(user.id, {
    onSuccess: () => {
      showToast(`${user.name} has been banned`);
      onClose();
    },
    onError: (error) => showToast(error.message, "error"),
  });
  const close = () => {
    ban.invalidateOwner();
    onClose();
  };

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Ban {user.name}?</DialogTitle>
      <DialogContent>
        <DialogContentText
          sx={{
            mb: 2,
          }}
        >
          The user will be prevented from signing in. You can unban them at any time.
        </DialogContentText>
        <TextField
          disabled={ban.isPending}
          label="Reason (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          size="small"
          fullWidth
          multiline
          rows={2}
        />
        {ban.error && (
          <span style={{ color: "red", fontSize: 13, display: "block", marginTop: 8 }}>
            {(ban.error as Error).message}
          </span>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={ban.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={ban.isPending}
          onClick={() => ban.mutate((client) => client.ban(user.id, reason.trim() || undefined))}
        >
          Ban User
        </Button>
      </DialogActions>
    </Dialog>
  );
}
