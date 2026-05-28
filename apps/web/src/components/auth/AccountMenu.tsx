"use client";

import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import LogoutIcon from "@mui/icons-material/Logout";
import SettingsIcon from "@mui/icons-material/Settings";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import type { User } from "@openmapx/core";
import { authClient, getInitials, proxyImageUrl } from "@openmapx/core";
import { useKeypairStore } from "@openmapx/mangrove-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

interface AccountMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  user: User;
  onOpenSettings: () => void;
}

export function AccountMenu({ anchorEl, onClose, user, onOpenSettings }: AccountMenuProps) {
  const open = Boolean(anchorEl);
  const t = useTranslations("account");
  const router = useRouter();
  const isAdmin = user.role === "admin";

  const handleSignOut = async () => {
    onClose();
    // Wipe the in-memory Mangrove keypair before tearing down the session so
    // the private JWK isn't reachable from any module after sign-out. The
    // server is the source of truth for the encrypted envelope — we only
    // hold decrypted material while a session is live.
    useKeypairStore.getState().clear();
    await authClient.signOut();
  };

  const handleSettings = () => {
    onClose();
    onOpenSettings();
  };

  const initials = getInitials(user.name, user.email);
  const avatarSrc = user.image ? proxyImageUrl(user.image) : undefined;

  return (
    <Menu
      anchorEl={anchorEl}
      open={open}
      onClose={onClose}
      onClick={onClose}
      transformOrigin={{ horizontal: "right", vertical: "top" }}
      anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
      slotProps={{
        paper: {
          sx: {
            width: 320,
            borderRadius: "12px",
            mt: 1,
            boxShadow: "0 4px 8px 3px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.3)",
            overflow: "hidden",
            "& .MuiList-root": { py: 0 },
            "& .MuiDivider-root": { my: 0 },
          },
        },
      }}
    >
      {/* User info header */}
      <Box sx={{ px: 2, py: 1.5, display: "flex", alignItems: "center", gap: 1.5 }}>
        <Avatar
          src={avatarSrc}
          sx={{
            width: 40,
            height: 40,
            bgcolor: "primary.main",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          {initials}
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {user.name}
          </Typography>
          <Typography
            variant="caption"
            noWrap
            sx={{
              color: "text.secondary",
            }}
          >
            {user.email}
          </Typography>
        </Box>
      </Box>
      <Divider sx={{ my: "0 !important" }} />
      <MenuItem onClick={handleSettings} sx={{ py: 1.5 }}>
        <ListItemIcon>
          <SettingsIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("accountSettings")}</ListItemText>
      </MenuItem>
      {isAdmin && (
        <MenuItem
          onClick={() => {
            onClose();
            router.push("/admin");
          }}
          sx={{ py: 1.5 }}
        >
          <ListItemIcon>
            <AdminPanelSettingsIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{t("adminPanel")}</ListItemText>
        </MenuItem>
      )}
      <Divider sx={{ my: "0 !important" }} />
      <MenuItem onClick={handleSignOut} sx={{ py: 1.5 }}>
        <ListItemIcon>
          <LogoutIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText>{t("signOut")}</ListItemText>
      </MenuItem>
    </Menu>
  );
}
