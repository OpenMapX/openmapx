"use client";

import Box from "@mui/material/Box";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { SEARCH_BAR_TOP } from "@/lib/layout";

/**
 * Desktop-only floating account avatar at the top-right of the map. On mobile
 * the avatar lives inside the SearchBar (see SearchBar.tsx) so it doesn't
 * occupy precious top-right space.
 */
export function TopRightControls() {
  return (
    <Box
      sx={{
        display: { xs: "none", sm: "flex" },
        position: "absolute",
        top: SEARCH_BAR_TOP,
        right: "calc(12px + var(--omx-safe-right))",
        alignItems: "center",
        gap: 1,
        zIndex: 10,
      }}
    >
      <AccountAvatarButton sx={{ boxShadow: 2 }} />
    </Box>
  );
}
