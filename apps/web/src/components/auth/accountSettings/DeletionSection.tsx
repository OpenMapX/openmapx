import DeleteIcon from "@mui/icons-material/Delete";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { authClient } from "@openmapx/core";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { clearPrivateDeviceData } from "@/lib/accountDeletionCleanup";
import { useCredentialRefusalMessage } from "../freshSignIn";
import { AccountSectionTitle, type SetAccountMessage } from "./shared";

export function DeletionSection({
  onDeleted,
  setMessage,
}: {
  /** The account is gone; `cleanupIncomplete` when this device still holds some of its data. */
  onDeleted: (cleanupIncomplete: boolean) => void;
  setMessage: SetAccountMessage;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const queryClient = useQueryClient();
  const refusalMessage = useCredentialRefusalMessage();
  const [confirming, setConfirming] = useState(false);

  // A recent sign-in confirms the deletion for every kind of account, so no
  // password is asked for here.
  const deleteAccount = async () => {
    try {
      const { error } = await authClient.deleteUser({});
      if (error) {
        setMessage(refusalMessage(error) ?? { type: "error", text: t("failedDeleteAccount") });
        return;
      }
      const { failures } = await clearPrivateDeviceData({ queryClient });
      // The account is gone either way: the settings close, and an incomplete
      // cleanup is told where the signed-out view lands.
      onDeleted(failures > 0);
    } catch {
      setMessage({ type: "error", text: t("failedDeleteAccount") });
    }
  };

  return (
    <>
      <AccountSectionTitle danger>{t("dangerZone")}</AccountSectionTitle>
      {!confirming ? (
        <Button
          variant="outlined"
          color="error"
          size="small"
          startIcon={<DeleteIcon />}
          onClick={() => setConfirming(true)}
        >
          {t("deleteAccount")}
        </Button>
      ) : (
        <Box>
          <Typography variant="body2" color="error" sx={{ mb: 1 }}>
            {t("deleteAccountWarning")}
          </Typography>
          <Box sx={{ display: "flex", gap: 1 }}>
            <Button variant="contained" color="error" size="small" onClick={deleteAccount}>
              {t("confirmDeletion")}
            </Button>
            <Button variant="outlined" size="small" onClick={() => setConfirming(false)}>
              {tc("cancel")}
            </Button>
          </Box>
        </Box>
      )}
    </>
  );
}
