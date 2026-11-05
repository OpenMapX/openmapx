"use client";
import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { accountError, unwrapAuthResult } from "@/lib/admin/accountAdmin";
import { browserAdminApiBase } from "@/lib/admin/browserAdminApiBase";
export function PasswordSetupForm() {
  const { apiUrl } = useEnv(),
    t = useTranslations("passwordSetup"),
    initialOrigin = useRef(apiUrl),
    capturedInitialLink = useRef(false),
    owner = useRef({ mounted: false, apiUrl, token: {} }),
    [bound, setBound] = useState<{ apiUrl: string; token: string } | null>(null),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<"expired" | "failed" | null>(null),
    [saved, setSaved] = useState(false);
  owner.current.apiUrl = apiUrl;
  useEffect(() => {
    owner.current.mounted = true;
    const capture = () => {
      owner.current.token = {};
      setPassword("");
      setConfirm("");
      setPending(false);
      setError(null);
      setSaved(false);
      const url = new URL(location.href),
        token =
          new URLSearchParams(url.hash.slice(1)).get("token") ??
          url.searchParams.get("token") ??
          "";
      setBound({
        apiUrl: initialOrigin.current,
        token: /^[A-Za-z0-9_-]{16,256}$/.test(token) ? token : "",
      });
      history.replaceState(history.state, "", url.pathname);
    };
    // React development replay must not reread the URL we just scrubbed.
    if (!capturedInitialLink.current) {
      capturedInitialLink.current = true;
      capture();
    }
    window.addEventListener("hashchange", capture);
    return () => {
      owner.current.mounted = false;
      window.removeEventListener("hashchange", capture);
    };
  }, []);
  const changed = bound?.apiUrl !== apiUrl,
    valid = !!bound?.token && !changed && password.length >= 8 && password === confirm;
  const save = async () => {
    if (!valid || pending || !bound) return;
    const origin = apiUrl,
      tokenOwner = owner.current.token;
    setPending(true);
    setError(null);
    try {
      unwrapAuthResult(
        await authClient.resetPassword({
          newPassword: password,
          token: bound.token,
          fetchOptions: {
            baseURL: `${browserAdminApiBase(origin)}/api/auth`,
            credentials: "include",
          },
        }),
      );
      if (
        owner.current.mounted &&
        owner.current.apiUrl === origin &&
        owner.current.token === tokenOwner
      ) {
        setSaved(true);
        setPassword("");
        setConfirm("");
      }
    } catch (error) {
      if (
        owner.current.mounted &&
        owner.current.apiUrl === origin &&
        owner.current.token === tokenOwner
      )
        setError(accountError(error).code === "INVALID_TOKEN" ? "expired" : "failed");
    } finally {
      if (
        owner.current.mounted &&
        owner.current.apiUrl === origin &&
        owner.current.token === tokenOwner
      )
        setPending(false);
    }
  };
  return (
    <Stack sx={{ minHeight: "100dvh", alignItems: "center", justifyContent: "center", p: 2 }}>
      <Paper variant="outlined" sx={{ p: 3, width: "100%", maxWidth: 440 }}>
        <Stack
          component="form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          sx={{ gap: 2 }}
        >
          <Typography component="h1" variant="h5">
            {t("title")}
          </Typography>
          {saved && !changed ? (
            <>
              <Alert severity="success">{t("saved")}</Alert>
              <Typography>{t("verificationSeparate")}</Typography>
            </>
          ) : (
            <>
              {bound && (!bound.token || changed) && (
                <Alert severity="error">{t(changed ? "originChanged" : "missingLink")}</Alert>
              )}
              {error && (
                <Alert severity="error">{t(error === "expired" ? "expiredLink" : "failed")}</Alert>
              )}
              <TextField
                label={t("newPassword")}
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={pending}
                onChange={(event) => setPassword(event.target.value)}
                slotProps={{ htmlInput: { minLength: 8, maxLength: 128 } }}
              />
              <TextField
                label={t("confirmPassword")}
                type="password"
                autoComplete="new-password"
                value={confirm}
                disabled={pending}
                onChange={(event) => setConfirm(event.target.value)}
                slotProps={{ htmlInput: { maxLength: 128 } }}
              />
              <Typography variant="body2">{t("requirements")}</Typography>
              <Button type="submit" variant="contained" disabled={!valid || pending}>
                {t("savePassword")}
              </Button>
            </>
          )}
          <Button component={Link} href="/">
            {t("back")}
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
