"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useSearchBarClearance } from "../searchBarClearance";

interface PanelDetailHeaderProps {
  onBack: () => void;
  children: ReactNode;
}

/**
 * Back-button header row shared by panel detail views (trip / line / etc.).
 * Renders the exact `display:flex` row + `IconButton` with `tc("back")` aria
 * label that these views hand-rolled, parameterising only the trailing content.
 * In a panel that runs under the floating search bar, the header pads itself
 * below it.
 */
export function PanelDetailHeader({ onBack, children }: PanelDetailHeaderProps) {
  const tc = useTranslations("common");
  const searchBarClearance = useSearchBarClearance();
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 1,
        pt: searchBarClearance ?? 1.5,
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
