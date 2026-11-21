"use client";

import CloseIcon from "@mui/icons-material/Close";
import PersonIcon from "@mui/icons-material/Person";
import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { User } from "@openmapx/core";
import { getInitials, proxyImageUrl } from "@openmapx/core";
import { useTranslations } from "next-intl";

/**
 * The top of the phone menu, which the avatar opens: who is signed in, with
 * their account settings a tap away — or the way to sign in. On a phone this
 * one menu holds the account and the app's places and tools together.
 */
export function MenuAccountHeader({
  user,
  onClose,
  onSignIn,
  onAccountSettings,
}: {
  user: User | null;
  onClose: () => void;
  onSignIn: () => void;
  onAccountSettings: () => void;
}) {
  const t = useTranslations("account");
  const tMap = useTranslations("map");
  const tCommon = useTranslations("common");
  const tMenu = useTranslations("menu");
  const close = (
    <IconButton onClick={onClose} aria-label={tCommon("close")} sx={{ mr: -1, flexShrink: 0 }}>
      <CloseIcon />
    </IconButton>
  );
  return (
    <Box sx={{ px: 2, pt: 1.5, pb: 2 }}>
      {user ? (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar
              src={user.image ? proxyImageUrl(user.image) : undefined}
              sx={{ width: 48, height: 48, bgcolor: "primary.main", fontSize: 18, fontWeight: 600 }}
            >
              {getInitials(user.name, user.email)}
            </Avatar>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography sx={{ fontSize: 18, fontWeight: 600 }} noWrap>
                {user.name}
              </Typography>
              <Typography variant="body2" sx={{ color: "text.secondary" }} noWrap>
                {user.email}
              </Typography>
            </Box>
            {close}
          </Box>
          <Button variant="tonal" onClick={onAccountSettings} sx={{ mt: 1.5, ml: 7.5 }}>
            {t("accountSettings")}
          </Button>
        </>
      ) : (
        <>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
            <Avatar
              sx={{ width: 48, height: 48, bgcolor: "action.selected", color: "text.secondary" }}
            >
              <PersonIcon />
            </Avatar>
            <Typography variant="body2" sx={{ color: "text.secondary", flex: 1, minWidth: 0 }}>
              {tMenu("signInHint")}
            </Typography>
            {close}
          </Box>
          <Button variant="contained" onClick={onSignIn} sx={{ mt: 1.5, ml: 7.5 }}>
            {tMap("signIn")}
          </Button>
        </>
      )}
    </Box>
  );
}
