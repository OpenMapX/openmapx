"use client";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useKeypairStore, useMangroveSigner } from "@openmapx/mangrove-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { MangroveConnectDialog } from "./MangroveConnectDialog";
import { MangroveLocalAccountSection } from "./MangroveLocalAccountSection";
export function MangroveAccountSection() {
  const t = useTranslations("account");
  const signer = useMangroveSigner();
  const [connect, setConnect] = useState(false);
  return (
    <Box sx={{ mb: 3 }}>
      {signer.mode === "local" ? (
        <>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            {t("mangroveLocalTitle")}
          </Typography>
          <MangroveLocalAccountSection />
          <Button onClick={() => setConnect(true)}>{t("mangroveSwitchSigner")}</Button>
        </>
      ) : (
        <Stack spacing={1.5}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Mangrove Reviews
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t("mangroveSharedIntro")}
          </Typography>
          {signer.status === "error" && (
            <Alert severity="warning">{t("mangroveConnectFailed")}</Alert>
          )}
          {signer.status === "expired" && (
            <Alert severity="info">{t("mangroveConnectionExpired")}</Alert>
          )}
          {signer.account && (
            <Alert severity="success">
              {t("mangroveConnectedAs", {
                name: signer.account.accountName ?? signer.account.reviewerId,
              })}
            </Alert>
          )}
          <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
            <Button variant="outlined" onClick={() => setConnect(true)}>
              {signer.account ? t("mangroveReconnect") : t("mangroveConnectTitle")}
            </Button>
            {(signer.account || signer.status === "error" || signer.status === "restoring") && (
              <Button
                onClick={() => {
                  useKeypairStore.getState().lock();
                  void signer.controller?.disconnect();
                }}
              >
                {t("mangroveDisconnect")}
              </Button>
            )}
            {signer.account && (
              <Button
                href="https://mangrove.reviews/account"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("mangroveManageAccount")}
              </Button>
            )}
          </Stack>
        </Stack>
      )}
      <MangroveConnectDialog
        open={connect}
        onClose={() => setConnect(false)}
        onLocal={() => setConnect(false)}
      />
    </Box>
  );
}
