"use client";

import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import CloseIcon from "@mui/icons-material/Close";
import DownloadForOfflineIcon from "@mui/icons-material/DownloadForOffline";
import HistoryIcon from "@mui/icons-material/History";
import ImageIcon from "@mui/icons-material/Image";
import LinkIcon from "@mui/icons-material/Link";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import PrintIcon from "@mui/icons-material/Print";
import SettingsIcon from "@mui/icons-material/Settings";
import StorageIcon from "@mui/icons-material/Storage";
import TimelineIcon from "@mui/icons-material/Timeline";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import {
  PANEL,
  useMenuStore,
  useParkedLocations,
  useParkingStore,
  useSession,
  useSidebarStore,
} from "@openmapx/core";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ChangeEvent, useRef, useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { InstallEntry, IosInstallHintDialog } from "@/components/pwa/InstallEntry";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { StorageDialog } from "@/components/settings/StorageDialog";
import { shareCurrentUrl } from "@/lib/deepLink";
import { IMPORT_ACCEPT, importGeoFromFile } from "@/lib/importGeoFile";

const DRAWER_WIDTH = 280;

export function HamburgerMenu() {
  const t = useTranslations("menu");
  const tCommon = useTranslations("common");
  const isOpen = useMenuStore((s) => s.isOpen);
  const close = useMenuStore((s) => s.close);
  const { data: session, isPending: sessionPending } = useSession();
  const { data: parked } = useParkedLocations();
  const isSignedIn = !sessionPending && !!session?.user?.id;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [iosHintOpen, setIosHintOpen] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-importing the same file later
    if (!file) return;
    const ok = await importGeoFromFile(file);
    if (ok) close();
    else setImportFailed(true);
  };

  const handleSaved = () => {
    close();
    if (!isSignedIn) {
      // Saved lists/labels are stored per-user behind auth; the API returns
      // 401 anyway. Prompt the user to sign in instead of opening an empty
      // panel.
      setAuthOpen(true);
      return;
    }
    useSidebarStore.getState().openSidebar(PANEL.SAVED);
  };

  const handleTimeline = () => {
    close();
    useSidebarStore.getState().openSidebar(PANEL.TIMELINE);
  };

  const handleParking = () => {
    close();
    const first = parked?.[0];
    if (!first) return;
    useParkingStore.getState().select(first.id);
    useSidebarStore.getState().openSidebar(PANEL.PARKING);
  };

  const handleShareMap = async () => {
    const result = await shareCurrentUrl({ title: "OpenMapX" });
    close();
    if (result === "copied") setSnackbarOpen(true);
  };

  return (
    <>
      <Drawer
        variant="temporary"
        anchor="left"
        open={isOpen}
        onClose={close}
        slotProps={{
          paper: {
            sx: { width: DRAWER_WIDTH },
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            py: 1.5,
          }}
        >
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            OpenMapX
          </Typography>
          <IconButton onClick={close} aria-label={tCommon("close")} size="small">
            <CloseIcon />
          </IconButton>
        </Box>

        <Divider />

        <List disablePadding>
          <ListItemButton sx={{ height: 48 }} onClick={handleSaved}>
            <ListItemIcon sx={{ minWidth: 40 }}>
              <BookmarkBorderIcon />
            </ListItemIcon>
            <ListItemText primary={t("saved")} />
          </ListItemButton>

          {isSignedIn && (
            <ListItemButton sx={{ height: 48 }} onClick={handleTimeline}>
              <ListItemIcon sx={{ minWidth: 40 }}>
                <TimelineIcon />
              </ListItemIcon>
              <ListItemText primary={t("timeline")} />
            </ListItemButton>
          )}

          {/* Conditional rather than disabled: an always-present "Parking" that
              does nothing teaches the user the entry is broken. */}
          {parked && parked.length > 0 && (
            <ListItemButton sx={{ height: 48 }} onClick={handleParking}>
              <ListItemIcon sx={{ minWidth: 40 }}>
                <LocalParkingIcon />
              </ListItemIcon>
              <ListItemText primary={t("parking")} />
            </ListItemButton>
          )}

          <ListItemButton
            sx={{ height: 48, opacity: 0.4, pointerEvents: "none" }}
            aria-disabled="true"
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <HistoryIcon />
            </ListItemIcon>
            <ListItemText primary={t("recent")} />
          </ListItemButton>

          <ListItemButton
            sx={{ height: 48, opacity: 0.4, pointerEvents: "none" }}
            aria-disabled="true"
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <ImageIcon />
            </ListItemIcon>
            <ListItemText primary={t("contributions")} />
          </ListItemButton>
        </List>

        <Divider />

        <List disablePadding>
          <InstallEntry onClick={close} onIosHintNeeded={() => setIosHintOpen(true)} />

          <ListItemButton
            component={Link}
            href="/settings/offline"
            sx={{ height: 48 }}
            onClick={close}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <DownloadForOfflineIcon />
            </ListItemIcon>
            <ListItemText primary={t("offlineMaps")} />
          </ListItemButton>

          <ListItemButton
            sx={{ height: 48 }}
            onClick={() => {
              close();
              setStorageOpen(true);
            }}
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <StorageIcon />
            </ListItemIcon>
            <ListItemText primary={t("storage")} />
          </ListItemButton>

          <ListItemButton sx={{ height: 48 }} onClick={handleShareMap}>
            <ListItemIcon sx={{ minWidth: 40 }}>
              <LinkIcon />
            </ListItemIcon>
            <ListItemText primary={t("shareMap")} />
          </ListItemButton>

          <ListItemButton sx={{ height: 48 }} onClick={() => fileInputRef.current?.click()}>
            <ListItemIcon sx={{ minWidth: 40 }}>
              <UploadFileIcon />
            </ListItemIcon>
            <ListItemText primary={t("importFile")} />
          </ListItemButton>

          <ListItemButton
            sx={{ height: 48, opacity: 0.4, pointerEvents: "none" }}
            aria-disabled="true"
          >
            <ListItemIcon sx={{ minWidth: 40 }}>
              <PrintIcon />
            </ListItemIcon>
            <ListItemText primary={t("print")} />
          </ListItemButton>
        </List>

        <Divider />

        <List disablePadding>
          <ListItemButton
            sx={{ height: 48, opacity: 0.4, pointerEvents: "none" }}
            aria-disabled="true"
          >
            <ListItemText primary={t("tips")} />
          </ListItemButton>

          <ListItemButton
            sx={{ height: 48, opacity: 0.4, pointerEvents: "none" }}
            aria-disabled="true"
          >
            <ListItemText primary={t("help")} />
          </ListItemButton>
        </List>

        <Divider />

        <List disablePadding>
          <ListItemButton sx={{ height: 48 }} onClick={() => setSettingsOpen(true)}>
            <ListItemIcon sx={{ minWidth: 40 }}>
              <SettingsIcon />
            </ListItemIcon>
            <ListItemText primary={t("settings")} />
          </ListItemButton>
        </List>

        <Divider />

        <List disablePadding>
          <ListItemButton component={Link} href="/privacy" sx={{ height: 48 }} onClick={close}>
            <ListItemText primary={t("privacy")} />
          </ListItemButton>

          <ListItemButton component={Link} href="/terms" sx={{ height: 48 }} onClick={close}>
            <ListItemText primary={t("terms")} />
          </ListItemButton>

          <ListItemButton component={Link} href="/imprint" sx={{ height: 48 }} onClick={close}>
            <ListItemText primary={t("imprint")} />
          </ListItemButton>
        </List>
      </Drawer>
      <input
        ref={fileInputRef}
        type="file"
        accept={IMPORT_ACCEPT}
        hidden
        onChange={(e) => void handleImportFile(e)}
      />
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={2500}
        onClose={() => setSnackbarOpen(false)}
        message={tCommon("copied")}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
      <Snackbar
        open={importFailed}
        autoHideDuration={3500}
        onClose={() => setImportFailed(false)}
        message={t("importFailed")}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <StorageDialog open={storageOpen} onClose={() => setStorageOpen(false)} />
      <IosInstallHintDialog open={iosHintOpen} onClose={() => setIosHintOpen(false)} />
    </>
  );
}
