"use client";

import GetAppIcon from "@mui/icons-material/GetApp";
import IosShareIcon from "@mui/icons-material/IosShare";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import { useTranslations } from "next-intl";
import { useInstallPrompt } from "./useInstallPrompt";

interface InstallEntryProps {
  /** Closes the surrounding drawer/menu. Called *after* the iOS hint is requested. */
  onClick?: () => void;
  /** Called when the user picks the install entry on iOS (no programmatic prompt). */
  onIosHintNeeded?: () => void;
}

/**
 * HamburgerMenu entry — only renders when an install path is available
 * (Android/Chrome `beforeinstallprompt` captured, or iOS Safari without an
 * existing install). The iOS hint dialog itself is rendered by the parent
 * (HamburgerMenu) so its lifecycle isn't bound to the drawer subtree — see
 * `IosInstallHintDialog` below.
 */
export function InstallEntry({ onClick, onIosHintNeeded }: InstallEntryProps) {
  const t = useTranslations("pwa");
  const { platform, shouldOfferInstall, promptInstall } = useInstallPrompt();

  if (!shouldOfferInstall) return null;

  const handle = async () => {
    if (platform === "ios") {
      // Notify the parent first so its dialog state flips before the drawer
      // closes. The parent owns the dialog, so it survives the drawer unmount.
      onIosHintNeeded?.();
      onClick?.();
      return;
    }
    onClick?.();
    // promptInstall records the dismissal itself; outcome is intentionally
    // unused here.
    await promptInstall();
  };

  return (
    <ListItemButton sx={{ height: 48 }} onClick={handle}>
      <ListItemIcon sx={{ minWidth: 40 }}>
        {platform === "ios" ? <IosShareIcon /> : <GetAppIcon />}
      </ListItemIcon>
      <ListItemText primary={t("installTitle")} />
    </ListItemButton>
  );
}

/**
 * iOS Add-to-Home-Screen hint. Rendered as a sibling of any drawer/menu so
 * closing the drawer doesn't unmount the dialog along with it.
 */
export function IosInstallHintDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("pwa");
  const { dismiss } = useInstallPrompt();

  const handleClose = () => {
    dismiss();
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose}>
      <DialogTitle>{t("iosHintTitle")}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t("iosHintDescription")}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>{t("gotIt")}</Button>
      </DialogActions>
    </Dialog>
  );
}
