"use client";

import CheckIcon from "@mui/icons-material/Check";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import { type Command, formatShortcut, getPlatform } from "@openmapx/command-palette";
import { useIntegrationOverlayActive } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { SyntheticEvent } from "react";
import { commandIcon } from "./commandIcons";

interface Props {
  command: Command;
  selected: boolean;
  onRun: (command: Command, event: SyntheticEvent | KeyboardEvent) => void;
  showGroupChip?: boolean;
}

export function CommandPaletteRow({ command, selected, onRun, showGroupChip = false }: Props) {
  const t = useTranslations("commandPalette");
  const overlayId = command.id.startsWith("overlays.") ? command.id.slice("overlays.".length) : "";
  const overlayActive = useIntegrationOverlayActive(overlayId);
  const isActive = overlayId ? overlayActive : (command.isActive?.() ?? false);
  const shortcutText = command.shortcut ? formatShortcut(command.shortcut, getPlatform()) : null;
  const groupKey = `group${command.group.charAt(0).toUpperCase()}${command.group.slice(1)}`;

  return (
    <ListItemButton
      id={`command-row-${command.id}`}
      role="option"
      aria-selected={selected}
      selected={selected}
      tabIndex={-1}
      onClick={(e) => onRun(command, e)}
      sx={{ borderRadius: 1, mx: 1, my: 0.25, minHeight: 44 }}
    >
      <ListItemIcon sx={{ minWidth: 36 }}>
        {command.iconPath ? (
          <svg
            viewBox="0 0 24 24"
            width={20}
            height={20}
            fill="currentColor"
            aria-hidden
            focusable={false}
            style={{ display: "block" }}
          >
            <title>{command.label}</title>
            <path d={command.iconPath} />
          </svg>
        ) : (
          commandIcon(command.iconKey)
        )}
      </ListItemIcon>
      <ListItemText
        primary={command.label}
        secondary={command.sublabel}
        slotProps={{
          primary: { sx: { fontSize: 14, fontWeight: 500 } },
          secondary: { sx: { fontSize: 12 } },
        }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ml: 1 }}>
        {isActive && (
          <CheckIcon
            fontSize="small"
            color="primary"
            aria-label={t("active")}
            titleAccess={t("active")}
          />
        )}
        {showGroupChip && (
          <Chip
            label={t(groupKey as never)}
            size="small"
            variant="outlined"
            sx={{ height: 20, fontSize: 11 }}
          />
        )}
        {shortcutText && (
          <Typography
            component="kbd"
            sx={(theme) => ({
              fontFamily: "monospace",
              fontSize: 12,
              px: 0.75,
              py: 0.25,
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 0.5,
              color: "text.secondary",
              minWidth: 24,
              textAlign: "center",
            })}
          >
            {shortcutText}
          </Typography>
        )}
      </Box>
    </ListItemButton>
  );
}
