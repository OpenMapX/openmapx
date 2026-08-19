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
import { authClient, getInitials, oauthProviders, proxyImageUrl } from "@openmapx/core";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";
import type { AccountSettingsSection } from "@/stores/accountSettingsStore";
import { MangroveAccountSection } from "./MangroveAccountSection";
import { TimelineConnectionSection } from "./TimelineConnectionSection";

interface AccountSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  user: User;
  initialSection: AccountSettingsSection;
}

export function AccountSettingsDialog({
  open,
  onClose,
  user,
  initialSection,
}: AccountSettingsDialogProps) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const fmt = useDateTimeFormat();
  const fullScreen = useFullScreenOnMobile();
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;
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
  const [deletePassword, setDeletePassword] = useState("");
  const [confirmUnlinkProvider, setConfirmUnlinkProvider] = useState<string | null>(null);
  const timelineHeadingRef = useRef<HTMLHeadingElement>(null);

  const focusInitialSection = () => {
    if (initialSection !== "timeline") return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    timelineHeadingRef.current?.focus({ preventScroll: true });
    timelineHeadingRef.current?.scrollIntoView({
      block: "start",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  };

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
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(
    !!(user as Record<string, unknown>).twoFactorEnabled,
  );
  const [totpSetupUri, setTotpSetupUri] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [totpVerifyCode, setTotpVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [twoFactorPassword, setTwoFactorPassword] = useState("");
  const [showTwoFactorSetup, setShowTwoFactorSetup] = useState(false);
  const [showDisable2fa, setShowDisable2fa] = useState(false);
  const [showBackupCodes, setShowBackupCodes] = useState(false);
  const sessionKey = open ? user.id : null;
  const [previousSessionKey, setPreviousSessionKey] = useState(sessionKey);

  if (sessionKey !== previousSessionKey) {
    setPreviousSessionKey(sessionKey);
    if (open) {
      setName(user.name);
      setMessage(null);
      setPasskeys([]);
      setLinkedAccounts([]);
      setConfirmDelete(false);
      setDeletePassword("");
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
    }
  }

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
    if (!sessionKey) return;
    let cancelled = false;

    // Load passkeys
    authClient.passkey.listUserPasskeys().then(({ data }) => {
      if (!cancelled && data) setPasskeys(data);
    });

    // Load linked accounts
    authClient.listAccounts().then(({ data }) => {
      if (!cancelled && data) {
        setLinkedAccounts(
          data.map((a: { providerId: string; accountId: string }) => ({
            providerId: a.providerId,
            accountId: a.accountId,
          })),
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionKey]);

  const handleUpdateProfile = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const { error } = await authClient.updateUser({ name });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("updateFailed")) });
      } else {
        setMessage({ type: "success", text: t("profileUpdated") });
      }
    } catch {
      setMessage({ type: "error", text: t("unexpectedError") });
    } finally {
      setSaving(false);
    }
  };

  // Email change handlers
  const handleRequestEmailChange = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.emailOtp.requestEmailChange({
        newEmail,
      });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedEmailChange")) });
        return;
      }
      setEmailOtpSent(true);
      setMessage({ type: "success", text: t("verificationCodeSent") });
    } catch {
      setMessage({ type: "error", text: t("failedChangeEmail") });
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
        setMessage({ type: "error", text: String(error.message ?? t("failedChangeEmail")) });
        return;
      }
      setMessage({ type: "success", text: t("emailUpdated") });
      setChangingEmail(false);
      setNewEmail("");
      setEmailOtp("");
      setEmailOtpSent(false);
    } catch {
      setMessage({ type: "error", text: t("failedChangeEmail") });
    }
  };

  // Password change handler
  const handleChangePassword = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
      });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedChangePassword")) });
        return;
      }
      setMessage({ type: "success", text: t("passwordChanged") });
      setChangingPassword(false);
      setCurrentPassword("");
      setNewPassword("");
    } catch {
      setMessage({ type: "error", text: t("failedChangePassword") });
    }
  };

  // 2FA handlers
  const handleEnable2FA = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.enable({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedEnable2FA")) });
        return;
      }
      if (data) {
        setTotpSetupUri(data.totpURI);
        setBackupCodes(data.backupCodes);
      }
    } catch {
      setMessage({ type: "error", text: t("failedEnable2FA") });
    }
  };

  const handleVerifyTotpSetup = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: totpVerifyCode,
      });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("invalidCode")) });
        return;
      }
      setTwoFactorEnabled(true);
      setShowTwoFactorSetup(false);
      setTotpSetupUri(null);
      setTwoFactorPassword("");
      setTotpVerifyCode("");
      setMessage({ type: "success", text: t("twoFAEnabled2") });
    } catch {
      setMessage({ type: "error", text: t("failedVerifyCode") });
    }
  };

  const handleDisable2FA = async () => {
    setMessage(null);
    try {
      const { error } = await authClient.twoFactor.disable({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({ type: "error", text: String(error.message ?? t("failedDisable2FA")) });
        return;
      }
      setTwoFactorEnabled(false);
      setShowDisable2fa(false);
      setTwoFactorPassword("");
      setBackupCodes(null);
      setMessage({ type: "success", text: t("twoFADisabled") });
    } catch {
      setMessage({ type: "error", text: t("failedDisable2FA") });
    }
  };

  const handleRegenerateBackupCodes = async () => {
    setMessage(null);
    try {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({
        password: twoFactorPassword,
      });
      if (error) {
        setMessage({
          type: "error",
          text: String(error.message ?? t("failedGenerateBackupCodes")),
        });
        return;
      }
      if (data) {
        setBackupCodes(data.backupCodes);
        setMessage({ type: "success", text: t("newBackupCodesGenerated") });
      }
    } catch {
      setMessage({ type: "error", text: t("failedGenerateBackupCodes") });
    }
  };

  const handleCopyBackupCodes = () => {
    if (backupCodes) {
      navigator.clipboard.writeText(backupCodes.join("\n"));
      setMessage({ type: "success", text: t("backupCodesCopied") });
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
          text: String(error.message ?? t("failedAddPasskey")),
        });
        return;
      }
      setMessage({ type: "success", text: t("passkeyAdded") });
      const { data } = await authClient.passkey.listUserPasskeys();
      if (data) setPasskeys(data);
    } catch {
      setMessage({ type: "error", text: t("failedAddPasskey") });
    }
  };

  const handleDeletePasskey = async (id: string) => {
    try {
      await authClient.passkey.deletePasskey({ id });
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      setMessage({ type: "success", text: t("passkeyRemoved") });
    } catch {
      setMessage({ type: "error", text: t("failedRemovePasskey") });
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
        text: t("failedLink", { provider: providerName }),
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
      setMessage({ type: "success", text: t("accountUnlinked", { provider: providerName }) });
    } catch {
      setMessage({ type: "error", text: t("failedUnlink", { provider: providerName }) });
    }
  };

  const hasCredential = linkedAccounts.some((a) => a.providerId === "credential");

  const handleDeleteAccount = async () => {
    try {
      const { error } = await authClient.deleteUser(
        hasCredential ? { password: deletePassword } : { callbackURL: "/" },
      );
      if (error) {
        setMessage({ type: "error", text: t("failedDeleteAccount") });
        return;
      }
      onClose();
    } catch {
      setMessage({ type: "error", text: t("failedDeleteAccount") });
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{
        paper: { sx: mobileFullScreenDialogPaperSx },
        transition: { onEntered: focusInitialSection },
      }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <PersonIcon />
        <Typography variant="h6" component="span" sx={{ flex: 1, fontWeight: 600 }}>
          {t("accountSettings")}
        </Typography>
        <IconButton onClick={onClose} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {message && (
          <Alert severity={message.type} sx={{ mb: 2 }}>
            {message.text}
          </Alert>
        )}

        {/* Profile Section */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("profile")}
        </Typography>
        <Box sx={{ display: "flex", alignItems: "center", gap: 2, mb: 2 }}>
          <Avatar
            src={avatarSrc}
            sx={{ width: 56, height: 56, bgcolor: "primary.main", fontSize: 22 }}
          >
            {getInitials(user.name, user.email)}
          </Avatar>
          <Box sx={{ flex: 1 }}>
            <TextField
              fullWidth
              label={t("name")}
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
          {t("saveChanges")}
        </Button>

        <Divider sx={{ mb: 2 }} />

        {/* Email Section */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("emailAddress")}
        </Typography>
        {!changingEmail ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 3 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                flex: 1,
              }}
            >
              {user.email}
            </Typography>
            <Button size="small" startIcon={<EditIcon />} onClick={() => setChangingEmail(true)}>
              {tc("change")}
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            <TextField
              fullWidth
              label={t("newEmailAddress")}
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              size="small"
              sx={{ mb: 1.5 }}
            />
            {emailOtpSent && (
              <TextField
                fullWidth
                label={t("verificationCode")}
                value={emailOtp}
                onChange={(e) => setEmailOtp(e.target.value)}
                size="small"
                sx={{ mb: 1.5 }}
                helperText={t("verificationCodeHelper")}
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
                  {t("sendVerificationCode")}
                </Button>
              ) : (
                <Button
                  variant="contained"
                  size="small"
                  onClick={handleConfirmEmailChange}
                  disabled={!emailOtp}
                >
                  {t("confirmChange")}
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
                {tc("cancel")}
              </Button>
            </Box>
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* Password Section */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("password")}
        </Typography>
        {!changingPassword ? (
          <Box sx={{ mb: 3 }}>
            <Button size="small" startIcon={<LockIcon />} onClick={() => setChangingPassword(true)}>
              {t("changePassword")}
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            <TextField
              fullWidth
              label={t("currentPassword")}
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
                        aria-label={t("toggleCurrentPasswordVisibility")}
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
              label={t("newPassword")}
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
                        aria-label={t("toggleNewPasswordVisibility")}
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
                {t("updatePassword")}
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
                {tc("cancel")}
              </Button>
            </Box>
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* Two-Factor Authentication */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("twoFactorAuth")}
        </Typography>
        {twoFactorEnabled ? (
          <Box sx={{ mb: 3 }}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
              <SecurityIcon fontSize="small" color="success" />
              <Typography
                variant="body2"
                sx={{
                  color: "success.main",
                  flex: 1,
                }}
              >
                {t("twoFAEnabled")}
              </Typography>
            </Box>

            {/* Action buttons -- shown when neither sub-panel is open */}
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
                  {t("backupCodes")}
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
                  {t("disable2FA")}
                </Button>
              </Box>
            )}

            {/* Backup codes panel */}
            {showBackupCodes && (
              <Box sx={{ mb: 2 }}>
                {!backupCodes ? (
                  <>
                    <Typography variant="body2" sx={{ mb: 1.5 }}>
                      {t("enterPasswordToRegenerate")}
                    </Typography>
                    <TextField
                      fullWidth
                      label={t("password")}
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
                        color="warning"
                        onClick={() => {
                          if (window.confirm(t("regenerateCodesConfirm"))) {
                            handleRegenerateBackupCodes();
                          }
                        }}
                        disabled={!twoFactorPassword}
                      >
                        {t("regenerateCodes")}
                      </Button>
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={() => {
                          setShowBackupCodes(false);
                          setTwoFactorPassword("");
                        }}
                      >
                        {tc("cancel")}
                      </Button>
                    </Box>
                  </>
                ) : (
                  <>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      {t("saveBackupCodes")}
                    </Typography>
                    <Box
                      sx={{
                        bgcolor: "action.hover",
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
                        {tc("copy")}
                      </Button>
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={handleDownloadBackupCodes}
                      >
                        {tc("download")}
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
                        {tc("done")}
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
                  {t("enterPasswordToDisable")}
                </Typography>
                <TextField
                  fullWidth
                  label={t("password")}
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
                    {t("disable2FA")}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setShowDisable2fa(false);
                      setTwoFactorPassword("");
                    }}
                  >
                    {tc("cancel")}
                  </Button>
                </Box>
              </Box>
            )}
          </Box>
        ) : !showTwoFactorSetup ? (
          <Box sx={{ mb: 3 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                mb: 1.5,
              }}
            >
              {t("twoFADescription")}
            </Typography>
            <Button
              size="small"
              startIcon={<SecurityIcon />}
              onClick={() => setShowTwoFactorSetup(true)}
            >
              {t("setUp2FA")}
            </Button>
          </Box>
        ) : (
          <Box sx={{ mb: 3 }}>
            {!totpSetupUri ? (
              <>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  {t("enterPasswordToSetup")}
                </Typography>
                <TextField
                  fullWidth
                  label={t("password")}
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
                    {tc("continue")}
                  </Button>
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={() => {
                      setShowTwoFactorSetup(false);
                      setTwoFactorPassword("");
                    }}
                  >
                    {tc("cancel")}
                  </Button>
                </Box>
              </>
            ) : (
              <>
                <Typography variant="body2" sx={{ mb: 1.5 }}>
                  {t("scanQRCode")}
                </Typography>
                <Box sx={{ textAlign: "center", mb: 2 }}>
                  {qrDataUrl && (
                    <Box
                      component="img"
                      src={qrDataUrl}
                      alt={t("totpQRCodeAlt")}
                      sx={{ width: 200, height: 200, borderRadius: 1 }}
                    />
                  )}
                </Box>
                <Typography
                  variant="caption"
                  sx={{
                    color: "text.secondary",
                    display: "block",
                    mb: 2,
                    wordBreak: "break-all",
                  }}
                >
                  {t("orEnterManually", { uri: totpSetupUri })}
                </Typography>

                {/* Show backup codes during setup */}
                {backupCodes && (
                  <Box sx={{ mb: 2 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                      {t("backupCodesTitle")}
                    </Typography>
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      {t("saveCodesDescription")}
                    </Typography>
                    <Box
                      sx={{
                        bgcolor: "action.hover",
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
                        {t("copyCodes")}
                      </Button>
                      <Button
                        size="small"
                        startIcon={<DownloadIcon />}
                        onClick={handleDownloadBackupCodes}
                      >
                        {tc("download")}
                      </Button>
                    </Box>
                  </Box>
                )}

                <Typography variant="body2" sx={{ mb: 1 }}>
                  {t("enterCodeToVerify")}
                </Typography>
                <TextField
                  fullWidth
                  label={t("verificationCode")}
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
                    {t("verifyAndEnable")}
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
                    {tc("cancel")}
                  </Button>
                </Box>
              </>
            )}
          </Box>
        )}

        <Divider sx={{ mb: 2 }} />

        {/* Connected Accounts */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("connectedAccounts")}
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
                  secondary={isLinked ? t("connected") : t("notConnected")}
                />
                {isLinked ? (
                  confirmUnlinkProvider === provider.providerId ? (
                    <Box sx={{ display: "flex", gap: 1 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => setConfirmUnlinkProvider(null)}
                      >
                        {tc("cancel")}
                      </Button>
                      <Button
                        size="small"
                        variant="contained"
                        color="error"
                        onClick={() => handleUnlinkProvider(provider.providerId, provider.name)}
                      >
                        {tc("confirm")}
                      </Button>
                    </Box>
                  ) : (
                    <Button
                      size="small"
                      color="error"
                      onClick={() => setConfirmUnlinkProvider(provider.providerId)}
                    >
                      {t("unlink")}
                    </Button>
                  )
                ) : (
                  <Button
                    size="small"
                    startIcon={<LinkIcon />}
                    onClick={() => handleLinkProvider(provider.providerId, provider.name)}
                  >
                    {t("connect")}
                  </Button>
                )}
              </ListItem>
            );
          })}
        </List>

        <Divider sx={{ my: 2 }} />

        <TimelineConnectionSection key={user.id} ref={timelineHeadingRef} ownerId={user.id} />

        <Divider sx={{ my: 2 }} />

        {/* Passkeys Section */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5 }}>
          {t("passkeys")}
        </Typography>
        {passkeys.length > 0 ? (
          <List dense disablePadding>
            {passkeys.map((pk) => (
              <ListItem
                key={pk.id}
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label={t("removePasskey")}
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
                  primary={pk.name ?? t("passkey")}
                  secondary={
                    pk.createdAt ? t("addedDate", { date: fmt.date(pk.createdAt) }) : undefined
                  }
                />
              </ListItem>
            ))}
          </List>
        ) : (
          <Typography
            variant="body2"
            sx={{
              color: "text.secondary",
              mb: 1,
            }}
          >
            {t("noPasskeys")}
          </Typography>
        )}
        <Button
          size="small"
          startIcon={<KeyIcon />}
          onClick={handleAddPasskey}
          sx={{ mt: 1, mb: 3 }}
        >
          {t("addPasskey")}
        </Button>

        <Divider sx={{ mb: 2 }} />

        <MangroveAccountSection />

        <Divider sx={{ mb: 2 }} />

        {/* Danger Zone */}
        <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1.5, color: "error.main" }}>
          {t("dangerZone")}
        </Typography>
        {!confirmDelete ? (
          <Button
            variant="outlined"
            color="error"
            size="small"
            startIcon={<DeleteIcon />}
            onClick={() => setConfirmDelete(true)}
          >
            {t("deleteAccount")}
          </Button>
        ) : (
          <Box>
            <Typography variant="body2" color="error" sx={{ mb: 1 }}>
              {t("deleteAccountWarning")}
            </Typography>
            {hasCredential && (
              <TextField
                type="password"
                size="small"
                fullWidth
                placeholder={t("password")}
                value={deletePassword}
                onChange={(e) => setDeletePassword(e.target.value)}
                sx={{ mb: 1 }}
              />
            )}
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                color="error"
                size="small"
                disabled={hasCredential && !deletePassword}
                onClick={handleDeleteAccount}
              >
                {t("confirmDeletion")}
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeletePassword("");
                }}
              >
                {tc("cancel")}
              </Button>
            </Box>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
