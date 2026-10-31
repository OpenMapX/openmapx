"use client";
import Alert from "@mui/material/Alert";
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
import type { AccountProvisioningResult } from "@openmapx/core/api-contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAdminToast } from "../shared/AdminToast";
import { AccountMailStatus } from "./AccountMailStatus";

interface Props {
  open: boolean;
  onClose: () => void;
}
export function CreateUserDialog(props: Props) {
  const scope = useAccountAdmin();
  return (
    <CreateUserForm key={JSON.stringify([scope.apiUrl, scope.actorId, props.open])} {...props} />
  );
}
function CreateUserForm({ open, onClose }: Props) {
  const toast = useAdminToast(),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState<"user" | "admin" | "privacy_admin">("user"),
    [sendInvitation, setSendInvitation] = useState(true),
    [created, setCreated] = useState<AccountProvisioningResult | null>(null),
    key = useRef<string | null>(null),
    create = useAccountAction<AccountProvisioningResult>("create", {
      viewKey: String(open),
      onSuccess: (value) => {
        setCreated(value);
        setPassword("");
        toast("Account created");
      },
      onError: (error) => toast(error.message, "error"),
    }),
    edit = (run: () => void) => {
      key.current = null;
      run();
    },
    close = () => {
      create.invalidateOwner();
      setPassword("");
      onClose();
    },
    valid =
      name.trim() && email.trim() && (!password || password.length >= 8) && password.length <= 128;
  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Create User</DialogTitle>
      <DialogContent>
        {created ? (
          <Stack sx={{ gap: 2, pt: 1 }}>
            <Alert severity="success">Account created. Email verification is separate.</Alert>
            <AccountMailStatus userId={created.userId} initial={created} />
            <Button component={Link} href={`/admin/users/${created.userId}`}>
              View account and recovery actions
            </Button>
          </Stack>
        ) : (
          <Stack sx={{ gap: 2, pt: 1 }}>
            <TextField
              disabled={create.isPending}
              label="Full Name"
              value={name}
              onChange={(e) => edit(() => setName(e.target.value))}
              size="small"
              fullWidth
              autoFocus
              slotProps={{ htmlInput: { maxLength: 256 } }}
            />
            <TextField
              disabled={create.isPending}
              label="Email"
              type="email"
              value={email}
              onChange={(e) => edit(() => setEmail(e.target.value))}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 320 } }}
            />
            <TextField
              disabled={create.isPending}
              label="Password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => edit(() => setPassword(e.target.value))}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 128 } }}
              helperText="Optional. Leave empty to send a one-use password setup link. The instance password policy applies."
            />
            <FormControl size="small" fullWidth>
              <InputLabel>Role</InputLabel>
              <Select
                disabled={create.isPending}
                value={role}
                label="Role"
                onChange={(e) => edit(() => setRole(e.target.value as typeof role))}
              >
                <MenuItem value="user">User</MenuItem>
                <MenuItem value="admin">Admin</MenuItem>
                <MenuItem value="privacy_admin">Privacy admin</MenuItem>
              </Select>
            </FormControl>
            <FormControlLabel
              control={
                <Checkbox
                  disabled={create.isPending}
                  checked={sendInvitation}
                  onChange={(e) => edit(() => setSendInvitation(e.target.checked))}
                  size="small"
                />
              }
              label="Send welcome email"
            />
            {!password && (
              <Alert severity="info">
                Without an initial password, a setup invitation is required. Verification and
                password setup are sent separately.
              </Alert>
            )}
            {create.error && <Alert severity="error">{create.error.message}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{created ? "Done" : "Cancel"}</Button>
        {!created && (
          <Button
            variant="contained"
            disabled={!valid || create.isPending}
            onClick={() => {
              key.current ??= crypto.randomUUID();
              const requestKey = key.current;
              create.mutate((client) =>
                client.create(
                  { name, email, role, sendInvitation, ...(password ? { password } : {}) },
                  requestKey,
                ),
              );
            }}
          >
            Create
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
