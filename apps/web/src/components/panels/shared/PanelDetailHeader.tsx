"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

interface PanelDetailHeaderProps {
  onBack: () => void;
  /** When true, pad the header below the floating search bar on larger screens. */
  clearSearchBar?: boolean;
  children: ReactNode;
}

/**
 * Back-button header row shared by panel detail views (trip / line / etc.).
 * Renders the exact `display:flex` row + `IconButton` with `tc("back")` aria
 * label that these views hand-rolled, parameterising only the search-bar
 * clearance padding and the trailing content.
 */
export function PanelDetailHeader({
  onBack,
  clearSearchBar = false,
  children,
}: PanelDetailHeaderProps) {
  const tc = useTranslations("common");
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1,
        pt: clearSearchBar ? { xs: 1.5, sm: "72px" } : 1.5,
        pb: 1.5,
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <IconButton size="small" onClick={onBack} aria-label={tc("back")}>
        <ArrowBackIcon />
      </IconButton>
      {children}
    </Box>
  );
}
