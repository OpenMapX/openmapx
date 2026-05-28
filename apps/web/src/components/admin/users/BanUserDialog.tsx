"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import { authClient } from "@openmapx/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAdminToast } from "../shared/AdminToast";

interface BanUserDialogProps {
  user: { id: string; name: string };
  onClose: () => void;
}

export function BanUserDialog({ user, onClose }: BanUserDialogProps) {
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [reason, setReason] = useState("");

  const ban = useMutation({
    mutationFn: () =>
      authClient.admin.banUser({
        userId: user.id,
        banReason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      showToast(`${user.name} has been banned`);
      onClose();
    },
    onError: (err) => showToast((err as Error).message || "Failed to ban user", "error"),
  });

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
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
        <Button onClick={onClose} disabled={ban.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color="error"
          disabled={ban.isPending}
          onClick={() => ban.mutate()}
        >
          Ban User
        </Button>
      </DialogActions>
    </Dialog>
  );
}
