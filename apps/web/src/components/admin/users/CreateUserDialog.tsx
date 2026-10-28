"use client";

import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useState } from "react";
import { useAccountAction } from "@/lib/admin/accountAdmin";
import { useAdminToast } from "../shared/AdminToast";

interface CreateUserDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateUserDialog({ open, onClose }: CreateUserDialogProps) {
  const showToast = useAdminToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [sendWelcome, setSendWelcome] = useState(true);

  const create = useAccountAction("create", {
    viewKey: String(open),
    onSuccess: () => {
      showToast("User created successfully");
      onClose();
      setName("");
      setEmail("");
      setPassword("");
      setRole("user");
    },
    onError: (error) => showToast(error.message, "error"),
  });
  const close = () => {
    create.invalidateOwner();
    onClose();
  };

  const valid = name.trim() && email.trim() && password.length >= 8;

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Create User</DialogTitle>
      <DialogContent>
        <Stack
          sx={{
            gap: 2,
            pt: 1,
          }}
        >
          <TextField
            disabled={create.isPending}
            label="Full Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
            fullWidth
            autoFocus
          />
          <TextField
            disabled={create.isPending}
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            disabled={create.isPending}
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            size="small"
            fullWidth
            helperText="Minimum 8 characters"
          />
          <FormControl size="small" fullWidth>
            <InputLabel>Role</InputLabel>
            <Select
              disabled={create.isPending}
              value={role}
              label="Role"
              onChange={(e) => setRole(e.target.value as "user" | "admin")}
            >
              <MenuItem value="user">User</MenuItem>
              <MenuItem value="admin">Admin</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Checkbox
                disabled={create.isPending}
                checked={sendWelcome}
                onChange={(e) => setSendWelcome(e.target.checked)}
                size="small"
              />
            }
            disabled={create.isPending}
            label="Send welcome email"
          />
          {create.error && (
            <span style={{ color: "red", fontSize: 13 }}>{(create.error as Error).message}</span>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={create.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!valid || create.isPending}
          onClick={() =>
            create.mutate((client) =>
              client.create({
                name,
                email,
                password,
                role,
                data: { sendWelcomeEmail: sendWelcome },
              }),
            )
          }
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
