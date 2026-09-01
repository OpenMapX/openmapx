"use client";

import type { Theme } from "@mui/material/styles";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { SystemStyleObject } from "@mui/system/styleFunctionSx";

/**
 * Returns `true` below the `sm` breakpoint. Spread into MUI Dialog props for
 * large content-heavy dialogs that would otherwise feel cramped on phones.
 *
 *   const fullScreen = useFullScreenOnMobile();
 *   <Dialog
 *     fullScreen={fullScreen}
 *     slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
 *   />
 *
 * The shared paper sx squares off the corners on mobile and vertically
 * centers DialogContent when its children don't fill the viewport (using
 * `safe center` so long, scrollable content still starts at the top).
 */
export function useFullScreenOnMobile(): boolean {
  const theme = useTheme();
  return useMediaQuery(theme.breakpoints.down("sm"));
}

export const mobileFullScreenDialogPaperSx: SystemStyleObject<Theme> = {
  borderRadius: { xs: 0, sm: "12px" },
  "& .MuiDialogContent-root": {
    display: { xs: "flex", sm: "block" },
    flexDirection: "column",
    justifyContent: "safe center",
  },
};
