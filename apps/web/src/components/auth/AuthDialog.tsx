"use client";

import KeyIcon from "@mui/icons-material/Key";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authClient, oauthProviders } from "@openmapx/core";
import { useState } from "react";

type AuthMode = "sign-in" | "sign-up" | "2fa" | "forgot-password" | "reset-password";

interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AuthDialog({ open, onClose }: AuthDialogProps) {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 2FA state
  const [totpCode, setTotpCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);

  // Password reset state
  const [resetOtp, setResetOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setName("");
    setError(null);
    setSuccessMessage(null);
    setShowPassword(false);
    setTotpCode("");
    setUseBackupCode(false);
    setResetOtp("");
    setNewPassword("");
  };

  const toggleMode = () => {
    setMode((m) => (m === "sign-in" ? "sign-up" : "sign-in"));
    resetForm();
  };

  const handleClose = () => {
    resetForm();
    setMode("sign-in");
    onClose();
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      if (mode === "sign-up") {
        const { error: signUpError } = await authClient.signUp.email({
          email,
          password,
          name,
        });
        if (signUpError) {
          setError(signUpError.message ?? "Sign up failed");
          return;
        }
      } else {
        const { data, error: signInError } = await authClient.signIn.email({
          email,
          password,
        });
        if (signInError) {
          setError(signInError.message ?? "Sign in failed");
          return;
        }
        if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) {
          setMode("2fa");
          setLoading(false);
          return;
        }
      }
      handleClose();
    } catch {
      setError("An unexpected error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (useBackupCode) {
        const { error: backupError } = await authClient.twoFactor.verifyBackupCode({
          code: totpCode,
        });
        if (backupError) {
          setError(backupError.message ?? "Invalid backup code");
          return;
        }
      } else {
        const { error: totpError } = await authClient.twoFactor.verifyTotp({
          code: totpCode,
        });
        if (totpError) {
          setError(totpError.message ?? "Invalid code");
          return;
        }
      }
      handleClose();
    } catch {
      setError("Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { error: resetError } = await authClient.emailOtp.requestPasswordReset({
        email,
      });
      if (resetError) {
        setError(resetError.message ?? "Failed to send reset code");
        return;
      }
      setMode("reset-password");
      setSuccessMessage("Verification code sent to your email");
    } catch {
      setError("Failed to send reset code");
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);
    try {
      const { error: resetError } = await authClient.emailOtp.resetPassword({
        email,
        otp: resetOtp,
        password: newPassword,
      });
      if (resetError) {
        setError(resetError.message ?? "Failed to reset password");
        return;
      }
      setSuccessMessage("Password reset successfully");
      setTimeout(() => {
        resetForm();
        setMode("sign-in");
      }, 1500);
    } catch {
      setError("Failed to reset password");
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeySignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const { error: passkeyError } = await authClient.signIn.passkey();
      if (passkeyError) {
        setError(passkeyError.message ?? "Passkey sign-in failed");
        return;
      }
      handleClose();
    } catch {
      setError("Passkey authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleOAuthSignIn = async (providerId: string, providerName: string) => {
    setLoading(true);
    setError(null);
    try {
      await authClient.signIn.oauth2({
        providerId,
        callbackURL: window.location.origin,
      });
    } catch {
      setError(`${providerName} sign-in failed`);
      setLoading(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: "12px",
          p: 0,
        },
      }}
    >
      <DialogContent sx={{ px: 5, py: 4 }}>
        {/* Logo / Title */}
        <Box sx={{ textAlign: "center", mb: 3 }}>
          <Typography variant="h5" sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}>
            {mode === "2fa"
              ? "2-Step Verification"
              : mode === "forgot-password"
                ? "Account recovery"
                : mode === "reset-password"
                  ? "Reset password"
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {mode === "2fa"
              ? "Enter the code from your authenticator app"
              : mode === "forgot-password"
                ? "Enter your email to receive a reset code"
                : mode === "reset-password"
                  ? "Enter the code and your new password"
                  : mode === "sign-in"
                    ? "Use your OpenMapX account"
                    : "Create your OpenMapX account"}
          </Typography>
        </Box>

        {successMessage && (
          <Alert severity="success" sx={{ mb: 2 }}>
            {successMessage}
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* ── Forgot password ───────────────────────────────── */}
        {mode === "forgot-password" ? (
          <Box component="form" onSubmit={handleForgotPassword}>
            <TextField
              fullWidth
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              size="small"
              sx={{ mb: 2 }}
              autoComplete="email"
              autoFocus
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={loading || !email}
              sx={{ mb: 2, py: 1.2, fontWeight: 600 }}
            >
              {loading ? <CircularProgress size={22} color="inherit" /> : "Send reset code"}
            </Button>
            <Box sx={{ textAlign: "center" }}>
              <Link
                component="button"
                type="button"
                variant="body2"
                onClick={() => {
                  setError(null);
                  setMode("sign-in");
                }}
                sx={{ fontWeight: 500 }}
              >
                Back to sign in
              </Link>
            </Box>
          </Box>
        ) : mode === "reset-password" ? (
          <Box component="form" onSubmit={handleResetPassword}>
            <TextField
              fullWidth
              label="Verification code"
              value={resetOtp}
              onChange={(e) => setResetOtp(e.target.value)}
              required
              size="small"
              sx={{ mb: 2 }}
              autoComplete="one-time-code"
              autoFocus
            />
            <TextField
              fullWidth
              label="New password"
              type={showPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              size="small"
              sx={{ mb: 2 }}
              autoComplete="new-password"
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label="toggle password visibility"
                        onClick={() => setShowPassword(!showPassword)}
                        edge="end"
                        size="small"
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={loading || !resetOtp || !newPassword}
              sx={{ mb: 2, py: 1.2, fontWeight: 600 }}
            >
              {loading ? <CircularProgress size={22} color="inherit" /> : "Reset password"}
            </Button>
            <Box sx={{ textAlign: "center" }}>
              <Link
                component="button"
                type="button"
                variant="body2"
                onClick={() => {
                  setError(null);
                  setSuccessMessage(null);
                  setMode("sign-in");
                }}
                sx={{ fontWeight: 500 }}
              >
                Back to sign in
              </Link>
            </Box>
          </Box>
        ) : mode === "2fa" ? (
          <Box component="form" onSubmit={handleVerifyTotp}>
            <TextField
              fullWidth
              label={useBackupCode ? "Backup code" : "6-digit code"}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value)}
              required
              size="small"
              sx={{ mb: 2 }}
              autoComplete="one-time-code"
              slotProps={{
                htmlInput: useBackupCode ? {} : { inputMode: "numeric", maxLength: 6 },
              }}
              autoFocus
            />
            <Button
              type="submit"
              variant="contained"
              fullWidth
              disabled={loading || !totpCode}
              sx={{ mb: 2, py: 1.2, fontWeight: 600 }}
            >
              {loading ? <CircularProgress size={22} color="inherit" /> : "Verify"}
            </Button>
            <Box sx={{ textAlign: "center" }}>
              <Link
                component="button"
                type="button"
                variant="body2"
                onClick={() => {
                  setUseBackupCode(!useBackupCode);
                  setTotpCode("");
                  setError(null);
                }}
                sx={{ fontWeight: 500 }}
              >
                {useBackupCode ? "Use authenticator app instead" : "Use a backup code instead"}
              </Link>
            </Box>
          </Box>
        ) : (
          <>
            {/* Email/Password form */}
            <Box component="form" onSubmit={handleEmailAuth}>
              {mode === "sign-up" && (
                <TextField
                  fullWidth
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  size="small"
                  sx={{ mb: 2 }}
                  autoComplete="name"
                />
              )}
              <TextField
                fullWidth
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                size="small"
                sx={{ mb: 2 }}
                autoComplete="email webauthn"
              />
              <TextField
                fullWidth
                label="Password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                size="small"
                sx={{ mb: 1 }}
                autoComplete={mode === "sign-in" ? "current-password webauthn" : "new-password"}
                slotProps={{
                  input: {
                    endAdornment: (
                      <InputAdornment position="end">
                        <IconButton
                          aria-label="toggle password visibility"
                          onClick={() => setShowPassword(!showPassword)}
                          edge="end"
                          size="small"
                        >
                          {showPassword ? <VisibilityOff /> : <Visibility />}
                        </IconButton>
                      </InputAdornment>
                    ),
                  },
                }}
              />

              {mode === "sign-in" && (
                <Typography variant="body2" sx={{ mb: 2 }}>
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={() => {
                      setError(null);
                      setMode("forgot-password");
                    }}
                    sx={{ fontWeight: 500 }}
                  >
                    Forgot password?
                  </Link>
                </Typography>
              )}

              <Button
                type="submit"
                variant="contained"
                fullWidth
                disabled={loading}
                sx={{ mt: 1, mb: 2, py: 1.2, fontWeight: 600 }}
              >
                {loading ? (
                  <CircularProgress size={22} color="inherit" />
                ) : mode === "sign-in" ? (
                  "Sign in"
                ) : (
                  "Create account"
                )}
              </Button>
            </Box>

            <Divider sx={{ my: 2 }}>
              <Typography variant="body2" color="text.secondary">
                or
              </Typography>
            </Divider>

            {/* Passkey sign-in */}
            {mode === "sign-in" && (
              <Button
                variant="outlined"
                fullWidth
                onClick={handlePasskeySignIn}
                disabled={loading}
                startIcon={<KeyIcon />}
                sx={{ mb: 1.5, py: 1, fontWeight: 500 }}
              >
                Sign in with passkey
              </Button>
            )}

            {/* OAuth provider sign-in buttons */}
            {oauthProviders.map((provider) => (
              <Button
                key={provider.providerId}
                variant="outlined"
                fullWidth
                onClick={() => handleOAuthSignIn(provider.providerId, provider.name)}
                disabled={loading}
                sx={{
                  mb: 1.5,
                  py: 1,
                  fontWeight: 500,
                  borderColor: "#666",
                  color: "text.primary",
                  "&:hover": {
                    borderColor: "#333",
                    bgcolor: "rgba(0,0,0,0.04)",
                  },
                }}
                startIcon={
                  <Box component="img" src={provider.icon} alt="" sx={{ width: 20, height: 20 }} />
                }
              >
                Continue with {provider.name}
              </Button>
            ))}

            {/* Toggle sign-in / sign-up */}
            <Box sx={{ textAlign: "center" }}>
              <Typography variant="body2" color="text.secondary">
                {mode === "sign-in" ? "Don\u2019t have an account?" : "Already have an account?"}{" "}
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={toggleMode}
                  sx={{ fontWeight: 600 }}
                >
                  {mode === "sign-in" ? "Create account" : "Sign in"}
                </Link>
              </Typography>
            </Box>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
