"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
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
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import Dialog from "@/components/ui/Dialog";
import { useAccountAction, useAccountAdmin } from "@/lib/admin/accountAdmin";
import { useAccountErrorText } from "@/lib/admin/useAccountErrorText";
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
  const t = useTranslations("adminUsers");
  const tCommon = useTranslations("common");
  const errorText = useAccountErrorText();
  const toast = useAdminToast(),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [role, setRole] = useState<"user" | "admin">("user"),
    [sendInvitation, setSendInvitation] = useState(true),
    [created, setCreated] = useState<AccountProvisioningResult | null>(null),
    key = useRef<string | null>(null),
    create = useAccountAction<AccountProvisioningResult>("create", {
      viewKey: String(open),
      onSuccess: (value) => {
        setCreated(value);
        setPassword("");
        toast(t("accountCreated"));
      },
      onError: (error) => toast(errorText(error), "error"),
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
      <DialogTitle>{t("createUser")}</DialogTitle>
      <DialogContent>
        {created ? (
          <Stack sx={{ gap: 2, pt: 1 }}>
            <Alert severity="success">{t("accountCreatedEmailVerificationIs")}</Alert>
            <AccountMailStatus userId={created.userId} initial={created} />
            <Button component={Link} href={`/admin/users/${created.userId}`}>
              {t("viewAccountAndRecoveryActions")}
            </Button>
          </Stack>
        ) : (
          <Stack sx={{ gap: 2, pt: 1 }}>
            <TextField
              disabled={create.isPending}
              label={t("fullName")}
              value={name}
              onChange={(e) => edit(() => setName(e.target.value))}
              size="small"
              fullWidth
              autoFocus
              slotProps={{ htmlInput: { maxLength: 256 } }}
            />
            <TextField
              disabled={create.isPending}
              label={t("email")}
              type="email"
              value={email}
              onChange={(e) => edit(() => setEmail(e.target.value))}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 320 } }}
            />
            <TextField
              disabled={create.isPending}
              label={t("password")}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => edit(() => setPassword(e.target.value))}
              size="small"
              fullWidth
              slotProps={{ htmlInput: { maxLength: 128 } }}
              helperText={t("optionalLeaveEmptyToSend")}
            />
            <FormControl size="small" fullWidth>
              <InputLabel>{t("role")}</InputLabel>
              <Select
                disabled={create.isPending}
                value={role}
                label={t("role")}
                onChange={(e) => edit(() => setRole(e.target.value as typeof role))}
              >
                <MenuItem value="user">{t("user")}</MenuItem>
                <MenuItem value="admin">{t("admin")}</MenuItem>
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
              label={t("sendWelcomeEmail")}
            />
            {!password && <Alert severity="info">{t("withoutAnInitialPasswordA")}</Alert>}
            {create.error && <Alert severity="error">{errorText(create.error)}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{created ? tCommon("done") : tCommon("cancel")}</Button>
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
            {t("create")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
