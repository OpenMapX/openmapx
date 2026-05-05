import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DownloadForOfflineIcon from "@mui/icons-material/DownloadForOffline";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

export default async function SettingsHomePage() {
  const t = await getTranslations("settings");
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
      </List>
    </Paper>
  );
}
