"use client";

import AdminPanelSettingsOutlinedIcon from "@mui/icons-material/AdminPanelSettingsOutlined";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import CloseIcon from "@mui/icons-material/Close";
import DownloadForOfflineOutlinedIcon from "@mui/icons-material/DownloadForOfflineOutlined";
import KeyboardOutlinedIcon from "@mui/icons-material/KeyboardOutlined";
import LinkIcon from "@mui/icons-material/Link";
import LocalParkingOutlinedIcon from "@mui/icons-material/LocalParkingOutlined";
import LogoutIcon from "@mui/icons-material/Logout";
import SettingsOutlinedIcon from "@mui/icons-material/SettingsOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import TimelineOutlinedIcon from "@mui/icons-material/TimelineOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { formatShortcut, getPlatform, parseShortcut } from "@openmapx/command-palette";
import {
  PANEL,
  useCommandPaletteStore,
  useMenuStore,
  useParkedLocations,
  useParkingStore,
  useSession,
  useSidebarStore,
} from "@openmapx/core";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  type ChangeEvent,
  type ComponentProps,
  type ComponentType,
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { useSignOut } from "@/components/auth/useSignOut";
import { InstallEntry, IosInstallHintDialog } from "@/components/pwa/InstallEntry";
import type { SettingsDialog as SettingsDialogComponent } from "@/components/settings/SettingsDialog";
import type { StorageDialog as StorageDialogComponent } from "@/components/settings/StorageDialog";
import { shareCurrentUrl } from "@/lib/deepLink";
import { IMPORT_ACCEPT, importGeoFromFile } from "@/lib/importGeoFile";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { useFinePointer } from "@/lib/useFinePointer";
import { useOpenedOnce } from "@/lib/useOpenedOnce";
import { warmChunksOnIdle } from "@/lib/warmChunksOnIdle";
import { useAccountSettingsStore } from "@/stores/accountSettingsStore";
import { MenuAccountHeader } from "./MenuAccountHeader";
import { MenuRow } from "./MenuRow";

// Settings and Storage are opened rarely, but Settings alone carries the EV
// vehicle table (~300 kB of source). Load each on its first opening; once loaded
// it stays mounted, exactly like the always-rendered dialog it replaces.
const loadSettingsDialog = () => import("@/components/settings/SettingsDialog");
const loadStorageDialog = () => import("@/components/settings/StorageDialog");

// A chunk that fails to load (offline before warm-up, or a deploy removed it)
// renders nothing instead of taking the map down, as PanelHost does.
const NoDialog = () => null;

const SettingsDialog = lazy<ComponentType<ComponentProps<typeof SettingsDialogComponent>>>(() =>
  loadSettingsDialog().then(
    (m) => ({ default: m.SettingsDialog }),
    () => ({ default: NoDialog }),
  ),
);
const StorageDialog = lazy<ComponentType<ComponentProps<typeof StorageDialogComponent>>>(() =>
  loadStorageDialog().then(
    (m) => ({ default: m.StorageDialog }),
    () => ({ default: NoDialog }),
  ),
);

const PALETTE_SHORTCUT = parseShortcut("Mod+K");

const DRAWER_WIDTH = 280;

export function HamburgerMenu() {
  const t = useTranslations("menu");
  const tCommon = useTranslations("common");
  const tFooter = useTranslations("footer");
  const tAccount = useTranslations("account");
  const isOpen = useMenuStore((s) => s.isOpen);
  const close = useMenuStore((s) => s.close);
  useBackDismiss(isOpen, close);
  const { data: session, isPending: sessionPending } = useSession();
  const { data: parked } = useParkedLocations();
  const isSignedIn = !sessionPending && !!session?.user?.id;
  const user = isSignedIn ? (session?.user ?? null) : null;
  // On a phone the avatar opens this menu, so it carries the account too and
  // slides in from the avatar's side across the screen.
  const theme = useTheme();
  const isPhone = useMediaQuery(theme.breakpoints.down("sm"));
  const signOut = useSignOut();
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);
  const [iosHintOpen, setIosHintOpen] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const settingsLoaded = useOpenedOnce(settingsOpen);
  const storageLoaded = useOpenedOnce(storageOpen);
  // An offline session must still be able to open these (sw.ts precaches no chunks).
  useEffect(() => warmChunksOnIdle([loadSettingsDialog, loadStorageDialog]), []);
  // The command palette is a keyboard tool; touch screens don't list it.
  const finePointer = useFinePointer();
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

  const handleCommandPalette = () => {
    close();
    useCommandPaletteStore.getState().open();
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
        anchor={isPhone ? "right" : "left"}
        open={isOpen}
        onClose={close}
        slotProps={{
          paper: {
            sx: { width: isPhone ? "100%" : DRAWER_WIDTH },
          },
        }}
      >
        {isPhone ? (
          <MenuAccountHeader
            user={user}
            onClose={close}
            onSignIn={() => {
              close();
              setAuthOpen(true);
            }}
            onAccountSettings={() => {
              close();
              useAccountSettingsStore.getState().show();
            }}
          />
        ) : (
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              px: 2,
              py: 1.5,
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <Box
                component="img"
                src="/icons/app/icon-192.png"
                alt=""
                sx={{ width: 32, height: 32, borderRadius: "22%", flexShrink: 0 }}
              />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                OpenMapX
              </Typography>
            </Box>
            <IconButton onClick={close} aria-label={tCommon("close")} size="small">
              <CloseIcon />
            </IconButton>
          </Box>
        )}

        <Divider />

        <List disablePadding sx={{ py: 1 }}>
          <MenuRow icon={<BookmarkBorderIcon />} label={t("saved")} onClick={handleSaved} />
          {isSignedIn && (
            <MenuRow
              icon={<TimelineOutlinedIcon />}
              label={t("timeline")}
              onClick={handleTimeline}
            />
          )}
          {/* Conditional rather than disabled: an always-present "Parking" that
              does nothing teaches the user the entry is broken. */}
          {parked && parked.length > 0 && (
            <MenuRow
              icon={<LocalParkingOutlinedIcon />}
              label={t("parking")}
              onClick={handleParking}
            />
          )}
        </List>

        <Divider />

        <List disablePadding sx={{ py: 1 }}>
          <InstallEntry onClick={close} onIosHintNeeded={() => setIosHintOpen(true)} />
          <MenuRow
            icon={<DownloadForOfflineOutlinedIcon />}
            label={t("offlineMaps")}
            href="/settings/offline"
            onClick={close}
          />
          <MenuRow
            icon={<StorageOutlinedIcon />}
            label={t("storage")}
            onClick={() => {
              close();
              setStorageOpen(true);
            }}
          />
          <MenuRow icon={<LinkIcon />} label={t("shareMap")} onClick={handleShareMap} />
          <MenuRow
            icon={<UploadFileOutlinedIcon />}
            label={t("importFile")}
            onClick={() => fileInputRef.current?.click()}
          />
        </List>

        <Divider />

        <List disablePadding sx={{ py: 1 }}>
          {finePointer && (
            <MenuRow
              icon={<KeyboardOutlinedIcon />}
              label={t("commandPalette")}
              hint={formatShortcut(PALETTE_SHORTCUT, getPlatform())}
              onClick={handleCommandPalette}
            />
          )}
          <MenuRow
            icon={<SettingsOutlinedIcon />}
            label={t("settings")}
            onClick={() => {
              close();
              setSettingsOpen(true);
            }}
          />
          {isPhone && user?.role === "admin" && (
            <MenuRow
              icon={<AdminPanelSettingsOutlinedIcon />}
              label={tAccount("adminPanel")}
              onClick={() => {
                close();
                router.push("/admin");
              }}
            />
          )}
          {isPhone && user && (
            <MenuRow
              icon={<LogoutIcon />}
              label={tAccount("signOut")}
              onClick={() => {
                close();
                void signOut();
              }}
            />
          )}
        </List>

        <Divider />

        <List disablePadding sx={{ py: 1 }}>
          <MenuRow label={t("privacy")} href="/privacy" onClick={close} />
          <MenuRow label={t("terms")} href="/terms" onClick={close} />
          <MenuRow label={t("imprint")} href="/imprint" onClick={close} />
          <MenuRow label={tFooter("licenses")} href="/licenses" onClick={close} />
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
      {settingsLoaded && (
        <Suspense fallback={null}>
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      )}
      {storageLoaded && (
        <Suspense fallback={null}>
          <StorageDialog open={storageOpen} onClose={() => setStorageOpen(false)} />
        </Suspense>
      )}
      <IosInstallHintDialog open={iosHintOpen} onClose={() => setIosHintOpen(false)} />
    </>
  );
}
