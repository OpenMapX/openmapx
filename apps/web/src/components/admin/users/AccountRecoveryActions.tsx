"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AccountProvisioningResult, AdminReauthProofRef } from "@openmapx/core/api-contracts";
import { useRef, useState } from "react";
import {
  type AccountRecoveryAction,
  useAccountAction,
  useAccountAdmin,
} from "@/lib/admin/accountAdmin";
import { AccountMailStatus } from "./AccountMailStatus";
import { AdminReauthenticationDialog } from "./AdminReauthenticationDialog";

type User = { id: string; name: string; email: string; emailVerified: boolean };
const labels: Record<AccountRecoveryAction, string> = {
  invitation: "Send invitation",
  "verification-email": "Send verification email",
  verify: "Verify email manually",
  "reset-password": "Send password reset",
  password: "Set temporary password",
};
export function AccountRecoveryActions({ user }: { user: User }) {
  const scope = useAccountAdmin();
  return (
    <RecoveryForm
      key={JSON.stringify([scope.apiUrl, scope.actorId, user.id, user.email, user.emailVerified])}
      user={user}
    />
  );
}
function RecoveryForm({ user }: { user: User }) {
  const [action, setAction] = useState<AccountRecoveryAction | null>(null),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(""),
    [password, setPassword] = useState(""),
    [reauth, setReauth] = useState(false),
    [success, setSuccess] = useState(false),
    key = useRef<string | null>(null),
    mutation = useAccountAction<AccountProvisioningResult>(user.id, {
      viewKey: action ?? "none",
      onSuccess: () => {
        setPassword("");
        setAction(null);
        setReauth(false);
        setSuccess(true);
      },
    }),
    needsReason = action === "verify" || action === "password",
    valid =
      confirmed &&
      (!needsReason || !!reason) &&
      (action !== "password" || (password.length >= 8 && password.length <= 128)),
    edit = (run: () => void) => {
      key.current = null;
      run();
    },
    close = () => {
      mutation.invalidateOwner();
      setPassword("");
      setAction(null);
      setReauth(false);
    },
    run = (proofs: AdminReauthProofRef[]) => {
      setReauth(false);
      const proof = proofs[0];
      if (!proof || !action || !valid) return;
      key.current ??= crypto.randomUUID();
      const requestKey = key.current,
        body =
          action === "verify"
            ? { confirmed: true, reasonCode: reason, expectedEmail: user.email }
            : action === "password"
              ? { confirmed: true, reasonCode: reason, password }
              : { confirmed: true };
      mutation.mutate((client) => client.recover(action, user.id, body, proof, requestKey));
    };
  return (
    <Stack id="account-recovery" sx={{ gap: 2 }}>
      <Typography variant="h6">Account recovery</Typography>
      <Typography variant="body2">
        Password setup does not verify an email address. Verify identity separately before assisted
        verification. Each action requires a fresh administrator sign-in.
      </Typography>
      {success && (
        <Alert severity="success">Account action completed. Check mail status separately.</Alert>
      )}
      <Stack direction="row" sx={{ gap: 1, flexWrap: "wrap" }}>
        {(Object.keys(labels) as AccountRecoveryAction[]).map((value) => (
          <Button
            key={value}
            variant="outlined"
            size="small"
            disabled={
              mutation.isPending ||
              (user.emailVerified && (value === "verify" || value === "verification-email"))
            }
            onClick={() => {
              key.current = null;
              setAction(value);
              setConfirmed(false);
              setReason("");
              setPassword("");
              setSuccess(false);
            }}
          >
            {labels[value]}
          </Button>
        ))}
      </Stack>
      <AccountMailStatus userId={user.id} />
      <Dialog open={!!action && !reauth} onClose={close} maxWidth="xs" fullWidth>
        <DialogTitle>{action ? labels[action] : "Account recovery"}</DialogTitle>
        <DialogContent>
          <Stack sx={{ gap: 2, pt: 1 }}>
            <Typography>
              {user.name} — {user.email}
            </Typography>
            {action === "verify" && (
              <Alert severity="warning">
                This bypasses email-link verification. Confirm the person’s identity and current
                address outside this flow.
              </Alert>
            )}
            {action === "password" && (
              <>
                <Alert severity="warning">
                  Existing sessions and reset links will be revoked. Share the temporary password
                  through a secure channel. Email verification stays unchanged.
                </Alert>
                <TextField
                  label="Temporary password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => edit(() => setPassword(e.target.value))}
                  slotProps={{ htmlInput: { maxLength: 128 } }}
                  disabled={mutation.isPending}
                />
              </>
            )}
            {needsReason && (
              <TextField
                select
                label="Reason"
                value={reason}
                onChange={(e) => edit(() => setReason(e.target.value))}
                disabled={mutation.isPending}
                slotProps={{ select: { native: true } }}
              >
                <option value="">Select a reason</option>
                <option value="identity_verified_out_of_band">Identity verified out of band</option>
                <option value="account_recovery">Account recovery</option>
                <option value="operator_request">Operator request</option>
              </TextField>
            )}
            <FormControlLabel
              control={
                <Checkbox
                  checked={confirmed}
                  onChange={(e) => edit(() => setConfirmed(e.target.checked))}
                  disabled={mutation.isPending}
                />
              }
              label={`I confirm this action for ${user.email}`}
            />
            {mutation.error && <Alert severity="error">{mutation.error.message}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={close}>Cancel</Button>
          <Button disabled={!valid || mutation.isPending} onClick={() => setReauth(true)}>
            Confirm administrator sign-in
          </Button>
        </DialogActions>
      </Dialog>
      {reauth && action && (
        <AdminReauthenticationDialog
          purpose={
            action === "verify"
              ? "account.verify"
              : action === "password"
                ? "account.password.set"
                : action === "reset-password"
                  ? "account.reset.send"
                  : "account.invite"
          }
          targetId={user.id}
          onCompleted={run}
          onClose={() => setReauth(false)}
        />
      )}
    </Stack>
  );
}
