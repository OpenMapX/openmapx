"use client";

import PersonIcon from "@mui/icons-material/Person";
import Avatar from "@mui/material/Avatar";
import type { SxProps, Theme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import { getInitials, proxyImageUrl, useSession } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { AccountMenu } from "./AccountMenu";
import { AccountSettingsDialog } from "./AccountSettingsDialog";
import { AuthDialog } from "./AuthDialog";
import { ResetPasswordDialog } from "./ResetPasswordDialog";

interface Props {
  /** Visual size of the avatar button. */
  size?: number;
  /** Optional sx merged onto the Avatar (e.g. omit boxShadow when inline). */
  sx?: SxProps<Theme>;
}

/** Avatar button with auth flow: opens AuthDialog when signed-out, AccountMenu when signed-in. */
export function AccountAvatarButton({ size = 36, sx }: Props) {
  const t = useTranslations("map");
  const { data: session, isPending } = useSession();
  const [authOpen, setAuthOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const avatarRef = useRef<HTMLButtonElement>(null);

  const user = session?.user ?? null;
  const avatarSrc = user?.image ? proxyImageUrl(user.image) : undefined;

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
      <Tooltip title={user ? (user.name ?? t("account")) : t("signIn")} placement="bottom">
        <Avatar
          ref={avatarRef}
          component="button"
          aria-label={t("account")}
          src={avatarSrc}
          onClick={handleAvatarClick}
          sx={[
            {
              width: size,
              height: size,
              bgcolor: user ? "primary.main" : "grey.400",
              fontSize: Math.round(size * 0.42),
              fontWeight: 500,
              cursor: "pointer",
              border: "none",
              fontFamily: "inherit",
              opacity: isPending ? 0.5 : 1,
            },
            ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
          ]}
        >
          {initials ?? <PersonIcon sx={{ fontSize: Math.round(size * 0.55) }} />}
        </Avatar>
      </Tooltip>

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
      <ResetPasswordDialog />

      {user && (
        <AccountMenu
          anchorEl={menuAnchor}
          onClose={() => setMenuAnchor(null)}
          user={user}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      )}

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
