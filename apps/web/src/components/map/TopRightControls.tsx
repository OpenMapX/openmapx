"use client";

import Box from "@mui/material/Box";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { SEARCH_BAR_HEIGHT, SEARCH_BAR_TOP } from "@/lib/layout";

/**
 * Desktop-only floating account control at the top-right of the map: the
 * avatar when signed in, a "Sign in" button otherwise. On mobile the avatar
 * lives inside the SearchBar (see SearchBar.tsx) so it doesn't occupy precious
 * top-right space.
 */
export function TopRightControls() {
  return (
    <Box
      sx={{
        display: { xs: "none", sm: "flex" },
        position: "absolute",
        top: SEARCH_BAR_TOP,
        // Level with the search bar's centre, like the chips beside it.
        height: SEARCH_BAR_HEIGHT,
        right: "calc(12px + var(--omx-safe-right))",
        alignItems: "center",
        gap: 1,
        zIndex: 10,
      }}
    >
      <AccountAvatarButton labelledSignIn sx={{ boxShadow: 2 }} />
    </Box>
  );
}
