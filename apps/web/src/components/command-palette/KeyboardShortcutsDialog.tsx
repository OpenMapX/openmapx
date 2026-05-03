"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import ListSubheader from "@mui/material/ListSubheader";
import Typography from "@mui/material/Typography";
import { type Command, formatShortcut, getPlatform, parseShortcut } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";

// Built-in shortcuts that aren't backed by a Command. Pre-parsed once.
const BUILTIN_SHORTCUTS = {
  palette: parseShortcut("Mod+K"),
  help: parseShortcut("?"),
  focusSearch: parseShortcut("/"),
};

interface Props {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

export function KeyboardShortcutsDialog({ open, onClose, commands }: Props) {
  const t = useTranslations("commandPalette");
  const tCommon = useTranslations("common");
  const platform = getPlatform();

  const grouped = useMemo(() => {
    type Row = { id: string; label: string; shortcut: string };
    const navigation: Row[] = [
      {
        id: "open-palette",
        label: t("open"),
        shortcut: formatShortcut(BUILTIN_SHORTCUTS.palette, platform),
      },
      {
        id: "show-help",
        label: t("cmdShowShortcuts"),
        shortcut: formatShortcut(BUILTIN_SHORTCUTS.help, platform),
      },
      {
        id: "focus-search",
        label: t("placeholder"),
        shortcut: formatShortcut(BUILTIN_SHORTCUTS.focusSearch, platform),
      },
    ];
    const layers: Row[] = [];
    const search: Row[] = [];
    const actions: Row[] = [];

    for (const cmd of commands) {
      if (!cmd.shortcut) continue;
      // Skip the help command itself — it's already hardcoded above so it
      // appears in the Navigation section, not duplicated under Actions.
      if (cmd.id === "actions.shortcuts") continue;
      const row: Row = {
        id: cmd.id,
        label: cmd.label,
        shortcut: formatShortcut(cmd.shortcut, platform),
      };
      if (cmd.group === "panels") navigation.push(row);
      else if (cmd.group === "layers" || cmd.group === "overlays") layers.push(row);
      else if (cmd.group === "categories") search.push(row);
      else actions.push(row);
    }

    return { navigation, layers, search, actions };
  }, [commands, t, platform]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {t("shortcutsTitle")}
        <IconButton onClick={onClose} aria-label={tCommon("close")} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List sx={{ py: 0 }}>
          <Section title={t("shortcutsSubtitleNavigation")} rows={grouped.navigation} />
          <Section title={t("shortcutsSubtitleLayers")} rows={grouped.layers} />
          <Section title={t("shortcutsSubtitleSearch")} rows={grouped.search} />
          <Section title={t("shortcutsSubtitleActions")} rows={grouped.actions} />
        </List>
      </DialogContent>
    </Dialog>
  );
}

function Section({
  title,
  rows,
}: {
  title: string;
  rows: { id: string; label: string; shortcut: string }[];
}) {
  if (rows.length === 0) return null;
  return (
    <li>
      <ul style={{ padding: 0, margin: 0, listStyle: "none" }}>
        <ListSubheader disableSticky sx={{ bgcolor: "background.default", fontWeight: 600 }}>
          {title}
        </ListSubheader>
        {rows.map((row) => (
          <ListItem key={row.id} sx={{ minHeight: 44 }}>
            <ListItemText primary={row.label} />
            <Box>
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
                })}
              >
                {row.shortcut}
              </Typography>
            </Box>
          </ListItem>
        ))}
      </ul>
    </li>
  );
}
