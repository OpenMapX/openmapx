"use client";

import PersonIcon from "@mui/icons-material/Person";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import { getInitials, useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { AccountMenu } from "@/components/auth/AccountMenu";
import { AccountSettingsDialog } from "@/components/auth/AccountSettingsDialog";
import { AuthDialog } from "@/components/auth/AuthDialog";

export function TopRightControls() {
  const t = useTranslations("map");
  const { data: session, isPending } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);

  const user = session?.user ?? null;

  const handleAvatarClick = () => {
    if (user) {
      setMenuAnchor(avatarRef.current);
    } else {
      setAuthOpen(true);
    }
  };

  const initials = user ? getInitials(user.name, user.email) : null;

  return (
    <>
      <Box
        sx={{
          position: "absolute",
          top: 12,
          right: 12,
          display: "flex",
          alignItems: "center",
          gap: 1,
          zIndex: 10,
        }}
      >
        <Tooltip title={user ? (user.name ?? t("account")) : t("signIn")} placement="bottom">
          <Avatar
            ref={avatarRef}
            component="button"
            aria-label={t("account")}
            src={user?.image ?? undefined}
            onClick={handleAvatarClick}
            sx={{
              width: 36,
              height: 36,
              bgcolor: user ? "primary.main" : "grey.400",
              fontSize: 15,
              fontWeight: 500,
              cursor: "pointer",
              border: "none",
              fontFamily: "inherit",
              boxShadow: 2,
              opacity: isPending ? 0.5 : 1,
            }}
          >
            {initials ?? <PersonIcon sx={{ fontSize: 20 }} />}
          </Avatar>
        </Tooltip>
      </Box>

      {/* Auth dialog (sign-in / sign-up) */}
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />

      {/* Account dropdown menu */}
      {user && (
        <AccountMenu
          anchorEl={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          user={user}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

      {/* Account settings dialog */}
      {user && (
        <AccountSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          user={user}
        />
      )}
    </>
  );
}
