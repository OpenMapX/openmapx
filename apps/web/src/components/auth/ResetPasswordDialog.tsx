"use client";

import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

function ResetPasswordDialogInner() {
  const t = useTranslations("auth");
  const router = useRouter();
  const searchParams = useSearchParams();

  // Better Auth redirects with ?token=... or ?error=...
  // We only treat "token" as a reset token when it looks like one (not a session/other token).
  // Better Auth's reset callback always sets callbackURL — so the presence of "token" on the
  // home page after a redirect means it's a password-reset token.
  const token = searchParams.get("token");
  const errorParam = searchParams.get("error");

  // Only open for password-reset related params
  const isResetFlow = !!(token || errorParam === "INVALID_TOKEN");

  const [open, setOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const initialized = useRef(false);

  useEffect(() => {
    if (isResetFlow && !initialized.current) {
      initialized.current = true;
      setOpen(true);
      if (errorParam) setError(errorParam);
    }
  }, [isResetFlow, errorParam]);

  const handleClose = useCallback(() => {
    setOpen(false);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("token");
    params.delete("error");
    const remaining = params.toString();
    router.replace(remaining ? `/?${remaining}` : "/", { scroll: false });
  }, [router, searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const { error: resetError } = await authClient.resetPassword({
        newPassword,
        token,
      });
      if (resetError) {
        setError(resetError.message ?? t("failedResetPassword"));
        return;
      }
      setSuccess(true);
      setTimeout(handleClose, 2000);
    } catch {
      setError(t("failedResetPassword"));
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="xs"
      fullWidth
      PaperProps={{ sx: { borderRadius: "12px", p: 0 } }}
    >
      <DialogContent sx={{ px: 5, py: 4 }}>
        <Box sx={{ textAlign: "center", mb: 3 }}>
          <Typography variant="h5" sx={{ fontWeight: 600, color: "text.primary", mb: 0.5 }}>
            {t("resetPassword")}
          </Typography>
        </Box>

        {success ? (
          <Alert severity="success">{t("passwordResetSuccess")}</Alert>
        ) : error || !token ? (
          <>
            <Alert severity="error" sx={{ mb: 2 }}>
              {error ?? t("invalidResetLink")}
            </Alert>
            <Button variant="contained" fullWidth onClick={handleClose}>
              {t("backToSignIn")}
            </Button>
          </>
        ) : (
          <Box component="form" onSubmit={handleSubmit}>
            <TextField
              fullWidth
              label={t("newPassword")}
              type={showPassword ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              size="small"
              sx={{ mb: 2 }}
              autoComplete="new-password"
              autoFocus
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label={t("togglePasswordVisibility")}
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
              disabled={loading || !newPassword}
              sx={{ py: 1.2, fontWeight: 600 }}
            >
              {loading ? <CircularProgress size={22} color="inherit" /> : t("resetPassword")}
            </Button>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ResetPasswordDialog() {
  return (
    <Suspense>
      <ResetPasswordDialogInner />
    </Suspense>
  );
}
