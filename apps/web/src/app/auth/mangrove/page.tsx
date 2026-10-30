"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Typography from "@mui/material/Typography";
import { useMangroveSigner } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useSettledSessionAuthority } from "@/providers/SessionAuthorityBoundary";
export default function MangroveCallbackPage() {
  const t = useTranslations("account");
  const signer = useMangroveSigner();
  const { isPending } = useSettledSessionAuthority();
  const original = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (isPending) return;
    original.current ??= window.location.href;
    window.history.replaceState(null, "", window.location.pathname);
    let current = true;
    if (!signer.controller) {
      setFailed(true);
      return;
    }
    void signer.controller.acceptCallback(original.current).then(
      (returnTo) => {
        if (current) window.location.replace(returnTo);
      },
      () => {
        if (current) setFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [signer.controller, isPending]);
  return (
    <Box sx={{ maxWidth: 560, mx: "auto", p: 3, mt: 6 }}>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {t("mangroveConnectTitle")}
      </Typography>
      {failed ? (
        <>
          <Alert severity="error" sx={{ mb: 2 }}>
            {t("mangroveCallbackFailed")}
          </Alert>
          <Button href="/" variant="contained">
            {t("mangroveReturn")}
          </Button>
        </>
      ) : (
        <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
          <CircularProgress size={24} />
          <Typography>{t("mangroveCallbackPending")}</Typography>
        </Box>
      )}
    </Box>
  );
}
