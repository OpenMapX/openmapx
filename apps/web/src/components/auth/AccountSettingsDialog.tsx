"use client";

import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import EditIcon from "@mui/icons-material/Edit";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import KeyIcon from "@mui/icons-material/Key";
import LinkIcon from "@mui/icons-material/Link";
import LockIcon from "@mui/icons-material/Lock";
import PersonIcon from "@mui/icons-material/Person";
import SecurityIcon from "@mui/icons-material/Security";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { User } from "@openmapx/core";
import { authClient, getInitials, oauthProviders } from "@openmapx/core";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

interface AccountSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  user: User;
}

export function AccountSettingsDialog({ open, onClose, user }: AccountSettingsDialogProps) {
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [passkeys, setPasskeys] = useState<
    { id: string; name?: string | null | undefined; createdAt?: Date | null | undefined }[]
  >([]);
  const [linkedAccounts, setLinkedAccounts] = useState<{ providerId: string; accountId: string }[]>(
    [],
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnlinkProvider, setConfirmUnlinkProvider] = useState<string | null>(null);

  // Email change state
  const [changingEmail, setChangingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [emailOtpSent, setEmailOtpSent] = useState(false);

  // Password change state
  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // 2FA state
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [totpSetupUri, setTotpSetupUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpVerifyCode, setTotpVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showDisable2fa, setShowDisable2fa] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState(false);

  useEffect(() => {
    if (!totpSetupUri) {
      setQrDataUrl(null);
      return;
    }
    QRCode.toDataURL(totpSetupUri, { width: 200, margin: 2 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [totpSetupUri]);

  useEffect(() => {
    if (!open) return;
    setName(user.name);
    setMessage(null);
    setConfirmDelete(false);
    setConfirmUnlinkProvider(null);
    setChangingEmail(false);
    setNewEmail("");
    setEmailOtp("");
    setEmailOtpSent(false);
    setChangingPassword(false);
    setCurrentPassword("");
    setNewPassword("");
    setShowCurrentPassword(false);
    setShowNewPassword(false);
    setShowTwoFactorSetup(false);
    setShowDisable2fa(false);
    setShowBackupCodes(false);
    setTotpSetupUri(null);
    setBackupCodes(null);
    setTwoFactorPassword("");
    setTotpVerifyCode("");
    setTwoFactorEnabled(!!(user as Record<string, unknown>).twoFactorEnabled);

    // Load passkeys
    authClient.passkey.listUserPasskeys().then(({ data }) => {
      if (data) setPasskeys(data);
    });

    // Load linked accounts
    authClient.listAccounts().then(({ data }) => {
      if (data) {
        setLinkedAccounts(
          data.map((a: { providerId: string; accountId: string }) => ({
            providerId: a.providerId,
            accountId: a.accountId,
          })),
        );
      }
    });
  }, [open, (user as Record<string, unknown>).twoFactorEnabled, user.name]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when dialog opens

  const handleUpdateProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Update failed" });
      } else {
        setMessage({ type: "success", text: "Profile updated" });
      }
    } catch {
      setMessage({ type: "error", text: "An unexpected error occurred" });
    } finally {
      setSaving(false);
    }
  };

  // ── Email change handlers ──────────────────────────────────────────
  const handleRequestEmailChange = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({
        newEmail,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to send verification code" });
        return;
      }
      setEmailOtpSent(true);
      setMessage({ type: "success", text: "Verification code sent to your new email" });
    } catch {
      setMessage({ type: "error", text: "Failed to request email change" });
    }
  };

  const handleConfirmEmailChange = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.emailOtp.changeEmail({
        newEmail,
        otp: emailOtp,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to change email" });
        return;
      }
      setMessage({ type: "success", text: "Email address updated" });
      setChangingEmail(false);
      setNewEmail("");
      setEmailOtp("");
      setEmailOtpSent(false);
    } catch {
      setMessage({ type: "error", text: "Failed to change email" });
    }
  };

  // ── Password change handler ────────────────────────────────────────
  const handleChangePassword = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to change password" });
        return;
      }
      setMessage({ type: "success", text: "Password changed" });
      setChangingPassword(false);
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setMessage({ type: "error", text: "Failed to change password" });
    }
  };

  // ── 2FA handlers ──────────────────────────────────────────────────
  const handleEnable2FA = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.enable({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to enable 2FA" });
        return;
      }
      if (data) {
        setTotpSetupUri(data.totpURI);
        setBackupCodes(data.backupCodes);
      }
    } catch {
      setMessage({ type: "error", text: "Failed to enable 2FA" });
    }
  };

  const handleVerifyTotpSetup = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: totpVerifyCode,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Invalid code" });
        return;
      }
      setTwoFactorEnabled(true);
      setShowTwoFactorSetup(false);
      setTotpSetupUri(null);
      setTwoFactorPassword("");
      setTotpVerifyCode("");
      setMessage({ type: "success", text: "Two-factor authentication enabled" });
    } catch {
      setMessage({ type: "error", text: "Failed to verify code" });
    }
  };

  const handleDisable2FA = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.disable({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to disable 2FA" });
        return;
      }
      setTwoFactorEnabled(false);
      setShowDisable2fa(false);
      setTwoFactorPassword("");
      setBackupCodes(null);
      setMessage({ type: "success", text: "Two-factor authentication disabled" });
    } catch {
      setMessage({ type: "error", text: "Failed to disable 2FA" });
    }
  };

  const handleRegenerateBackupCodes = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: error.message ?? "Failed to generate backup codes" });
        return;
      }
      if (data) {
        setBackupCodes(data.backupCodes);
        setMessage({ type: "success", text: "New backup codes generated" });
      }
    } catch {
      setMessage({ type: "error", text: "Failed to generate backup codes" });
    }
  };

  const handleCopyBackupCodes = () => {
    if (backupCodes) {
      navigator.clipboard.writeText(backupCodes.join("\n"));
      setMessage({ type: "success", text: "Backup codes copied to clipboard" });
    }
  };

  const handleDownloadBackupCodes = () => {
    if (!backupCodes) return;
    const content = `OpenMapX Backup Codes\n${"=".repeat(22)}\n\n${backupCodes.join("\n")}\n\nEach code can only be used once.\nStore these codes in a safe place.\n`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "openmapx-backup-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleAddPasskey = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.passkey.addPasskey();
      if (error) {
        setMessage({
          type: "error",
          text: error.message ?? "Failed to add passkey",
        });
        return;
      }
      setMessage({ type: "success", text: "Passkey added" });
      const { data } = await authClient.passkey.listUserPasskeys();
      if (data) setPasskeys(data);
    } catch {
      setMessage({ type: "error", text: "Failed to add passkey" });
    }
  };

  const handleDeletePasskey = async (id: string) => {
    try {
      await authClient.passkey.deletePasskey({ id });
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      setMessage({ type: "success", text: "Passkey removed" });
    } catch {
      setMessage({ type: "error", text: "Failed to remove passkey" });
    }
  };

  const handleLinkProvider = async (providerId: string, providerName: string) => {
    try {
      await authClient.oauth2.link({
        providerId,
        callbackURL: window.location.origin,
      });
    } catch {
      setMessage({
        type: "error",
        text: `Failed to link ${providerName} account`,
      });
    }
  };

  const handleUnlinkProvider = async (providerId: string, providerName: string) => {
    try {
      const account = linkedAccounts.find((a) => a.providerId === providerId);
      if (!account) return;
      await authClient.unlinkAccount({ providerId, accountId: account.accountId });
      setLinkedAccounts((prev) => prev.filter((a) => a.providerId !== providerId));
      setConfirmUnlinkProvider(null);
      setMessage({ type: "success", text: `${providerName} account unlinked` });
    } catch {
      setMessage({ type: "error", text: `Failed to unlink ${providerName} account` });
    }
  };

  const handleDeleteAccount = async () => {
    try {
      await authClient.deleteUser();
      onClose();
    } catch {
      setMessage({ type: "error", text: "Failed to delete account" });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{ sx: { borderRadius: "12px" } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <PersonIcon />
        <Typography variant="h6" component="span" sx={{ flex: 1, fontWeight: 600 }}>
          Account settings
        </Typography>
        <IconButton onClick={onClose} aria-label="Close" edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {message && (
          <Alert severity={message.type} sx={{ mb: 2 }}>
            {message.text}
          </Alert>
        )}

        {/* ── Profile Section ─────────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Profile
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
          <Avatar
            src={user.image ?? undefined}
            sx={{ width: 56, height: 56, bgcolor: "primary.main", fontSize: 22 }}
          >
            {getInitials(user.name, user.email)}
          </Avatar>
          <Box sx={{ flex: 1 }}>
            <TextField
              fullWidth
              label="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              size="small"
            />
          </Box>
        </Box>
        <Button
          variant="contained"
          size="small"
          onClick={handleUpdateProfile}
          disabled={saving || name === user.name}
          sx={{ mb: 3 }}
        >
          Save changes
        </Button>

        <Divider sx={{ mb: 2 }} />

        {/* ── Email Section ───────────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Email address
        </Typography>
        {!changingEmail ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3 }}>
            <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
              {user.email}
            </Typography>
            <Button size="small" startIcon={<EditIcon />} onClick={() => setChangingEmail(true)}>
              Change
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            <TextField
              fullWidth
              label="New email address"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              size="small"
              sx={{ mb: 1.5 }}
            />
            {emailOtpSent && (
              <TextField
                fullWidth
                label="Verification code"
                value={emailOtp}
                onChange={(e) => setEmailOtp(e.target.value)}
                size="small"
                sx={{ mb: 1.5 }}
                helperText="Enter the code sent to your new email"
              />
            )}
            <Box sx={{ display: "flex", gap: 1 }}>
              {!emailOtpSent ? (
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleRequestEmailChange}
                  disabled={!newEmail}
                >
                  Send verification code
                </Button>
              ) : (
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleConfirmEmailChange}
                  disabled={!emailOtp}
                >
                  Confirm change
                </Button>
              )}
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setChangingEmail(false);
                  setNewEmail("");
                  setEmailOtp("");
                  setEmailOtpSent(false);
                }}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* ── Password Section ────────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Password
        </Typography>
        {!changingPassword ? (
          <Box sx={{ mb: 3 }}>
            <Button size="small" startIcon={<LockIcon />} onClick={() => setChangingPassword(true)}>
              Change password
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            <TextField
              fullWidth
              label="Current password"
              type={showCurrentPassword ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              size="small"
              sx={{ mb: 1.5 }}
              autoComplete="current-password"
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle current password visibility"
                        onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                        edge="end"
                        size="small"
                      >
                        {showCurrentPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <TextField
              fullWidth
              label="New password"
              type={showNewPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              size="small"
              sx={{ mb: 1.5 }}
              autoComplete="new-password"
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle new password visibility"
                        onClick={() => setShowNewPassword(!showNewPassword)}
                        edge="end"
                        size="small"
                      >
                        {showNewPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                size="small"
                onClick={handleChangePassword}
                disabled={!currentPassword || !newPassword}
              >
                Update password
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setChangingPassword(false);
                  setCurrentPassword("");
                  setNewPassword("");
                }}
              >
                Cancel
              </Button>
            </Box>
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* ── Two-Factor Authentication ───────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Two-factor authentication
        </Typography>
        {twoFactorEnabled ? (
          <Box sx={{ mb: 3 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
              <SecurityIcon fontSize="small" color="success" />
              <Typography variant="body2" color="success.main" sx={{ flex: 1 }}>
                2FA is enabled
              </Typography>
            </Box>

            {/* Action buttons — shown when neither sub-panel is open */}
            {!showBackupCodes && !showDisable2fa && (
              <Box sx={{ display: "flex", gap: 1 }}>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<KeyIcon />}
                  onClick={() => {
                    setShowBackupCodes(true);
                    setShowDisable2fa(false);
                    setTwoFactorPassword("");
                    setBackupCodes(null);
                  }}
                >
                  Backup codes
                </Button>
                <Button
                  size="small"
                  color="error"
                  onClick={() => {
                    setShowDisable2fa(true);
                    setShowBackupCodes(false);
                    setTwoFactorPassword("");
                    setBackupCodes(null);
                  }}
                >
                  Disable 2FA
                </Button>
              </Box>
            )}

            {/* Backup codes panel */}
            {showBackupCodes && (
              <Box sx={{ mb: 2 }}>
                {!backupCodes ? (
                  <>
                    <Typography variant="body2" sx={{ mb: 1.5 }}>
                      Enter your password to view your backup codes.
                    </Typography>
                    <TextField
                      fullWidth
                      label="Password"
                      type="password"
                      value={twoFactorPassword}
                      onChange={(e) => setTwoFactorPassword(e.target.value)}
                      size="small"
                      sx={{ mb: 1.5 }}
                      autoComplete="current-password"
                    />
                    <Box sx={{ display: "flex", gap: 1 }}>
                      <Button
                        variant="contained"
                        size="small"
                        onClick={handleRegenerateBackupCodes}
                        disabled={!twoFactorPassword}
                      >
                        View codes
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => {
                          setShowBackupCodes(false);
                          setTwoFactorPassword("");
                        }}
                      >
                        Cancel
                      </Button>
                    </Box>
                  </>
                ) : (
                  <>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      Save these backup codes in a safe place. Each code can only be used once.
                    </Typography>
                    <Box
                      sx={{
                        bgcolor: "grey.100",
                        borderRadius: 1,
                        p: 2,
                        fontFamily: "monospace",
                        fontSize: 13,
                        mb: 1,
                      }}
                    >
                      {backupCodes.map((code) => (
                        <Box key={code}>{code}</Box>
                      ))}
                    </Box>
                    <Box sx={{ display: "flex", gap: 1 }}>
                      <Button
                        size="small"
                        startIcon={<ContentCopyIcon />}
                        onClick={handleCopyBackupCodes}
                      >
                        Copy
                      </Button>
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={handleDownloadBackupCodes}
                      >
                        Download
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => {
                          setShowBackupCodes(false);
                          setBackupCodes(null);
                          setTwoFactorPassword("");
                        }}
                      >
                        Done
                      </Button>
                    </Box>
                  </>
                )}
              </Box>
            )}

            {/* Disable 2FA confirmation */}
            {showDisable2fa && (
              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" color="error" sx={{ mb: 1 }}>
                  Enter your password to disable two-factor authentication.
                </Typography>
                <TextField
                  fullWidth
                  label="Password"
                  type="password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  size="small"
                  sx={{ mb: 1.5 }}
                  autoComplete="current-password"
                />
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button
                    variant="contained"
                    color="error"
                    size="small"
                    onClick={handleDisable2FA}
                    disabled={!twoFactorPassword}
                  >
                    Disable 2FA
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setShowDisable2fa(false);
                      setTwoFactorPassword("");
                    }}
                  >
                    Cancel
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        ) : !showTwoFactorSetup ? (
          <Box sx={{ mb: 3 }}>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              Add an extra layer of security to your account with a TOTP authenticator app.
            </Typography>
            <Button
              size="small"
              startIcon={<SecurityIcon />}
              onClick={() => setShowTwoFactorSetup(true)}
            >
              Set up 2FA
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            {!totpSetupUri ? (
              <>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  Enter your password to set up two-factor authentication.
                </Typography>
                <TextField
                  fullWidth
                  label="Password"
                  type="password"
                  value={twoFactorPassword}
                  onChange={(e) => setTwoFactorPassword(e.target.value)}
                  size="small"
                  sx={{ mb: 1.5 }}
                  autoComplete="current-password"
                />
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleEnable2FA}
                    disabled={!twoFactorPassword}
                  >
                    Continue
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setShowTwoFactorSetup(false);
                      setTwoFactorPassword("");
                    }}
                  >
                    Cancel
                  </Button>
                </Box>
              </>
            ) : (
              <>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  Scan this QR code with your authenticator app (Google Authenticator, Authy, etc.):
                </Typography>
                <Box sx={{ textAlign: "center", mb: 2 }}>
                  {qrDataUrl && (
                    <Box
                      component="img"
                      src={qrDataUrl}
                      alt="TOTP QR Code"
                      sx={{ width: 200, height: 200, borderRadius: 1 }}
                    />
                  )}
                </Box>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ display: "block", mb: 2, wordBreak: "break-all" }}
                >
                  Or enter manually: {totpSetupUri}
                </Typography>

                {/* Show backup codes during setup */}
                {backupCodes && (
                  <Box sx={{ mb: 2 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                      Backup codes
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      Save these codes in a safe place. You can use them to sign in if you lose
                      access to your authenticator app.
                    </Typography>
                    <Box
                      sx={{
                        bgcolor: "grey.100",
                        borderRadius: 1,
                        p: 2,
                        fontFamily: "monospace",
                        fontSize: 13,
                        mb: 1,
                      }}
                    >
                      {backupCodes.map((code) => (
                        <Box key={code}>{code}</Box>
                      ))}
                    </Box>
                    <Box sx={{ display: "flex", gap: 1, mb: 2 }}>
                      <Button
                        size="small"
                        startIcon={<ContentCopyIcon />}
                        onClick={handleCopyBackupCodes}
                      >
                        Copy codes
                      </Button>
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={handleDownloadBackupCodes}
                      >
                        Download
                      </Button>
                    </Box>
                  </Box>
                )}

                <Typography variant="body2" sx={{ mb: 1 }}>
                  Enter the 6-digit code from your authenticator app to verify:
                </Typography>
                <TextField
                  fullWidth
                  label="Verification code"
                  value={totpVerifyCode}
                  onChange={(e) => setTotpVerifyCode(e.target.value)}
                  size="small"
                  sx={{ mb: 1.5 }}
                  autoComplete="one-time-code"
                  slotProps={{ htmlInput: { inputMode: "numeric", maxLength: 6 } }}
                />
                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleVerifyTotpSetup}
                    disabled={totpVerifyCode.length < 6}
                  >
                    Verify & enable
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setShowTwoFactorSetup(false);
                      setTotpSetupUri(null);
                      setBackupCodes(null);
                      setTwoFactorPassword("");
                      setTotpVerifyCode("");
                    }}
                  >
                    Cancel
                  </Button>
                </Box>
              </>
            )}
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* ── Connected Accounts ──────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Connected accounts
        </Typography>
        <List dense disablePadding>
          {oauthProviders.map((provider) => {
            const isLinked = linkedAccounts.some((a) => a.providerId === provider.providerId);
            return (
              <ListItem key={provider.providerId}>
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <Box
                    component="img"
                    src={provider.icon}
                    alt={provider.name}
                    sx={{ width: 20, height: 20 }}
                  />
                </ListItemIcon>
                <ListItemText
                  primary={provider.name}
                  secondary={isLinked ? "Connected" : "Not connected"}
                />
                {isLinked ? (
                  confirmUnlinkProvider === provider.providerId ? (
                    <Box sx={{ display: "flex", gap: 1 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => setConfirmUnlinkProvider(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        color="error"
                        onClick={() => handleUnlinkProvider(provider.providerId, provider.name)}
                      >
                        Confirm
                      </Button>
                    </Box>
                  ) : (
                    <Button
                      size="small"
                      color="error"
                      onClick={() => setConfirmUnlinkProvider(provider.providerId)}
                    >
                      Unlink
                    </Button>
                  )
                ) : (
                  <Button
                    size="small"
                    startIcon={<LinkIcon />}
                    onClick={() => handleLinkProvider(provider.providerId, provider.name)}
                  >
                    Connect
                  </Button>
                )}
              </ListItem>
            );
          })}
        </List>

        <Divider sx={{ my: 2 }} />

        {/* ── Passkeys Section ────────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          Passkeys
        </Typography>
        {passkeys.length > 0 ? (
          <List dense disablePadding>
            {passkeys.map((pk) => (
              <ListItem
                key={pk.id}
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label="Remove passkey"
                    onClick={() => handleDeletePasskey(pk.id)}
                    size="small"
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                }
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <FingerprintIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={pk.name ?? "Passkey"}
                  secondary={
                    pk.createdAt
                      ? `Added ${new Date(pk.createdAt).toLocaleDateString()}`
                      : undefined
                  }
                />
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            No passkeys registered yet.
          </Typography>
        )}
        <Button
          size="small"
          startIcon={<KeyIcon />}
          onClick={handleAddPasskey}
          sx={{ mt: 1, mb: 3 }}
        >
          Add a passkey
        </Button>

        <Divider sx={{ mb: 2 }} />

        {/* ── Danger Zone ─────────────────────────────────────── */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5, color: "error.main" }}>
          Danger zone
        </Typography>
        {!confirmDelete ? (
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => setConfirmDelete(true)}
          >
            Delete account
          </Button>
        ) : (
          <Box>
            <Typography variant="body2" color="error" sx={{ mb: 1 }}>
              This action is irreversible. All your data will be permanently deleted.
            </Typography>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button variant="contained" color="error" size="small" onClick={handleDeleteAccount}>
                Confirm deletion
              </Button>
              <Button variant="outlined" size="small" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
