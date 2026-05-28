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
import { authClient } from "@openmapx/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useAdminToast } from "../shared/AdminToast";

interface CreateUserDialogProps {
  open: boolean;
  onClose: () => void;
}

export function CreateUserDialog({ open, onClose }: CreateUserDialogProps) {
  const qc = useQueryClient();
  const showToast = useAdminToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [sendWelcome, setSendWelcome] = useState(true);

  const create = useMutation({
    mutationFn: () =>
      authClient.admin.createUser({
        name,
        email,
        password,
        role,
        data: { sendWelcomeEmail: sendWelcome },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      showToast("User created successfully");
      onClose();
      setName("");
      setEmail("");
      setPassword("");
      setRole("user");
    },
    onError: (err) => showToast((err as Error).message || "Failed to create user", "error"),
  });

  const valid = name.trim() && email.trim() && password.length >= 8;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Create User</DialogTitle>
      <DialogContent>
        <Stack
          sx={{
            gap: 2,
            pt: 1,
          }}
        >
          <TextField
            label="Full Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
            fullWidth
            autoFocus
          />
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
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
                checked={sendWelcome}
                onChange={(e) => setSendWelcome(e.target.checked)}
                size="small"
              />
            }
            label="Send welcome email"
          />
          {create.error && (
            <span style={{ color: "red", fontSize: 13 }}>{(create.error as Error).message}</span>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={create.isPending}>
          Cancel
        </Button>
        <Button
          variant="contained"
          disabled={!valid || create.isPending}
          onClick={() => create.mutate()}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}
