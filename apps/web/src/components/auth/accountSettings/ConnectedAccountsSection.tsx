import LinkIcon from "@mui/icons-material/Link";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { oauthProviders } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { useAccountCredentials } from "../useAccountCredentials";
import { AccountSectionTitle } from "./shared";

type Credentials = ReturnType<typeof useAccountCredentials>;

function ProviderAction({
  provider,
  credentials,
}: {
  provider: (typeof oauthProviders)[number];
  credentials: Credentials;
}) {
  const t = useTranslations("account");
  const tc = useTranslations("common");
  const { linkedAccounts, confirmUnlinkProvider, setConfirmUnlinkProvider, providersBusy } =
    credentials;
  if (!linkedAccounts.some((a) => a.providerId === provider.providerId)) {
    return (
      <Button
        size="small"
        startIcon={<LinkIcon />}
        disabled={providersBusy}
        onClick={() => credentials.linkProvider(provider.providerId, provider.name)}
      >
        {t("connect")}
      </Button>
    );
  }
  if (confirmUnlinkProvider !== provider.providerId) {
    return (
      <Button
        size="small"
        color="error"
        disabled={providersBusy}
        onClick={() => setConfirmUnlinkProvider(provider.providerId)}
      >
        {t("unlink")}
      </Button>
    );
  }
  return (
    <Box sx={{ display: "flex", gap: 1 }}>
      <Button
        size="small"
        variant="outlined"
        disabled={providersBusy}
        onClick={() => setConfirmUnlinkProvider(null)}
      >
        {tc("cancel")}
      </Button>
      <Button
        size="small"
        variant="contained"
        color="error"
        disabled={providersBusy}
        onClick={() => credentials.unlinkProvider(provider.providerId, provider.name)}
      >
        {tc("confirm")}
      </Button>
    </Box>
  );
}

export function ConnectedAccountsSection({ credentials }: { credentials: Credentials }) {
  const t = useTranslations("account");
  return (
    <>
      <AccountSectionTitle>{t("connectedAccounts")}</AccountSectionTitle>
      <List dense disablePadding>
        {oauthProviders.map((provider) => (
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
              secondary={
                credentials.linkedAccounts.some((a) => a.providerId === provider.providerId)
                  ? t("connected")
                  : t("notConnected")
              }
            />
            <ProviderAction provider={provider} credentials={credentials} />
          </ListItem>
        ))}
      </List>
    </>
  );
}
