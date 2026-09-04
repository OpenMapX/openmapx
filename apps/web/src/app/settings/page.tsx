import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DownloadForOfflineIcon from "@mui/icons-material/DownloadForOffline";
import PrivacyTipIcon from "@mui/icons-material/PrivacyTip";
import TuneIcon from "@mui/icons-material/Tune";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function SettingsHomePage() {
  const t = await getTranslations("settings");
  const privacy = await getTranslations("account.privacyData");
  return (
    <Paper variant="outlined" sx={{ borderRadius: 2 }}>
      <List disablePadding>
        <Link href="/settings/offline" style={{ textDecoration: "none", color: "inherit" }}>
          <ListItemButton>
            <ListItemIcon>
              <DownloadForOfflineIcon />
            </ListItemIcon>
            <ListItemText primary={t("offline")} secondary={t("offlineDescription")} />
            <ChevronRightIcon color="action" />
          </ListItemButton>
        </Link>
        <Link href="/settings/preferences" style={{ textDecoration: "none", color: "inherit" }}>
          <ListItemButton>
            <ListItemIcon>
              <TuneIcon />
            </ListItemIcon>
            <ListItemText primary={t("preferencesTitle")} secondary={t("preferencesDescription")} />
            <ChevronRightIcon color="action" />
          </ListItemButton>
        </Link>
        <Link href="/settings/privacy" style={{ textDecoration: "none", color: "inherit" }}>
          <ListItemButton>
            <ListItemIcon>
              <PrivacyTipIcon />
            </ListItemIcon>
            <ListItemText primary={privacy("title")} />
            <ChevronRightIcon color="action" />
          </ListItemButton>
        </Link>
      </List>
    </Paper>
  );
}
