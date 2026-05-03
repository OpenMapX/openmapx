"use client";

import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import { useTranslations } from "next-intl";
import { forwardRef, type KeyboardEvent } from "react";
import { COMMAND_PALETTE_LISTBOX_ID } from "./constants";

interface Props {
  query: string;
  onQueryChange: (q: string) => void;
  onClose: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  activeDescendantId: string | null;
}

export const CommandPaletteInput = forwardRef<HTMLInputElement, Props>(function CommandPaletteInput(
  { query, onQueryChange, onClose, onKeyDown, activeDescendantId },
  ref,
) {
  const t = useTranslations("commandPalette");
  const tCommon = useTranslations("common");

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        px: 2,
        py: 1.25,
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <SearchIcon color="action" fontSize="small" />
      <InputBase
        inputRef={ref}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t("placeholder")}
        autoFocus
        fullWidth
        inputProps={{
          role: "combobox",
          "aria-label": t("inputAriaLabel"),
          "aria-expanded": true,
          "aria-controls": COMMAND_PALETTE_LISTBOX_ID,
          "aria-activedescendant": activeDescendantId ?? undefined,
          "aria-autocomplete": "list",
        }}
        sx={{ fontSize: 16 }}
      />
      <IconButton onClick={onClose} aria-label={tCommon("close")} size="small">
        <CloseIcon fontSize="small" />
      </IconButton>
    </Box>
  );
});
