import DeleteIcon from "@mui/icons-material/Delete";
import FingerprintIcon from "@mui/icons-material/Fingerprint";
import KeyIcon from "@mui/icons-material/Key";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import type { useAccountCredentials } from "../useAccountCredentials";
import { AccountSectionTitle } from "./shared";

export function PasskeysSection({
  credentials,
}: {
  credentials: ReturnType<typeof useAccountCredentials>;
}) {
  const t = useTranslations("account");
  const fmt = useDateTimeFormat();
  const { passkeys, passkeysBusy } = credentials;
  return (
    <>
      <AccountSectionTitle>{t("passkeys")}</AccountSectionTitle>
      {passkeys.length > 0 ? (
        <List dense disablePadding>
          {passkeys.map((pk) => (
            <ListItem
              key={pk.id}
              secondaryAction={
                <IconButton
                  edge="end"
                  aria-label={t("removePasskey")}
                  disabled={passkeysBusy}
                  onClick={() => credentials.deletePasskey(pk.id)}
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
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
          {t("noPasskeys")}
        </Typography>
      )}
      <Button
        size="small"
        startIcon={<KeyIcon />}
        disabled={passkeysBusy}
        onClick={credentials.addPasskey}
        sx={{ mt: 1, mb: 3 }}
      >
        {t("addPasskey")}
      </Button>
    </>
  );
}
