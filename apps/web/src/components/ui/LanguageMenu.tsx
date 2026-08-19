"use client";

import CheckIcon from "@mui/icons-material/Check";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useLocale } from "next-intl";
import { locales } from "@/i18n/config";
import { setLocaleAndReload } from "@/lib/setLocale";

const localeNames: Record<string, string> = {
  en: "English",
  de: "Deutsch",
};

interface LanguageMenuProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
}

export function LanguageMenu({ anchorEl, onClose }: LanguageMenuProps) {
  const locale = useLocale();

  const handleLanguageChange = (newLocale: string) => {
    onClose();
    if (newLocale === locale) return;
    void setLocaleAndReload(newLocale);
  };

  return (
    <Menu
      anchorEl={anchorEl}
      open={Boolean(anchorEl)}
      onClose={onClose}
      anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
      transformOrigin={{ horizontal: "right", vertical: "top" }}
      slotProps={{
        paper: {
          sx: {
            borderRadius: "8px",
            boxShadow: "0 4px 8px 3px rgba(0,0,0,.15), 0 1px 3px rgba(0,0,0,.3)",
            minWidth: 160,
            mt: 0.5,
          },
        },
      }}
    >
      {locales.map((l) => (
        <MenuItem
          key={l}
          selected={l === locale}
          onClick={() => handleLanguageChange(l)}
          sx={{ py: 1 }}
        >
          <ListItemIcon sx={{ minWidth: 28 }}>
            {l === locale ? <CheckIcon fontSize="small" /> : null}
          </ListItemIcon>
          <ListItemText>{localeNames[l] ?? l}</ListItemText>
        </MenuItem>
      ))}
    </Menu>
  );
}
