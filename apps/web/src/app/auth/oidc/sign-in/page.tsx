"use client";

import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { AuthDialog } from "@/components/auth/AuthDialog";

export default function OidcSignInPage() {
  const t = useTranslations("auth.oidcProvider");
  const tc = useTranslations("common");
  const session = authClient.useSession();

  if (session.isPending) {
    return (
      <Box
        sx={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          bgcolor: "background.default",
        }}
      >
        <CircularProgress aria-label={t("checkingSession")} />
      </Box>
    );
  }

  if (session.error || session.data) {
    const alreadySignedIn = Boolean(session.data) && !session.error;
    return (
      <Box
        component="main"
        sx={{
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          p: 3,
          bgcolor: "background.default",
        }}
      >
        <Paper sx={{ width: "min(100%, 30rem)", p: 4, borderRadius: 3 }} elevation={2}>
          <Typography component="h1" variant="h5" sx={{ fontWeight: 650, mb: 1 }}>
            {t(alreadySignedIn ? "alreadySignedInTitle" : "sessionErrorTitle")}
          </Typography>
          <Alert severity={alreadySignedIn ? "info" : "error"} sx={{ my: 2 }}>
            {t(alreadySignedIn ? "alreadySignedInBody" : "sessionError")}
          </Alert>
          <Box sx={{ display: "flex", gap: 1.5, flexWrap: "wrap" }}>
            <Button variant="contained" onClick={() => window.location.reload()}>
              {tc("retry")}
            </Button>
            <Link href="/" sx={{ alignSelf: "center", fontWeight: 600 }}>
              {t("backToOpenMapX")}
            </Link>
          </Box>
        </Paper>
      </Box>
    );
  }

  return (
    <Box
      component="main"
      sx={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        p: 3,
        bgcolor: "background.default",
      }}
    >
      <Box sx={{ maxWidth: "32rem", textAlign: "center" }}>
        <Typography component="h1" variant="h4" sx={{ fontWeight: 650, mb: 1 }}>
          {t("signInTitle")}
        </Typography>
        <Typography color="text.secondary">{t("signInBody")}</Typography>
      </Box>
      <AuthDialog open dismissible={false} onClose={() => {}} />
    </Box>
  );
}
