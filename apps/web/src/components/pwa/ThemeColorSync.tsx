"use client";

import { useColorScheme } from "@mui/material/styles";
import { useEffect } from "react";
import { applyThemeColor } from "@/lib/themeColor";

/**
 * Keeps the status bar on the theme chosen in settings. The `theme-color`
 * tags only follow the system scheme, so a user who picked Dark on a phone
 * set to light would otherwise get a bright bar above a dark app.
 */
export function ThemeColorSync() {
  const { mode } = useColorScheme();
  useEffect(() => {
    applyThemeColor(mode === "light" || mode === "dark" ? mode : null);
  }, [mode]);
  return null;
}
