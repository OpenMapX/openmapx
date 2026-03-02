"use client";

import LocationOnIcon from "@mui/icons-material/LocationOn";
import SearchIcon from "@mui/icons-material/Search";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import type { AutocompleteResult } from "@openmapx/core";

interface AutocompleteDropdownProps {
  suggestions: AutocompleteResult[];
  onSelect: (result: AutocompleteResult) => void;
}

const iconByType: Record<AutocompleteResult["type"], React.ReactNode> = {
  address: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  poi: <SearchIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  street: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  region: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
};

export function AutocompleteDropdown({ suggestions, onSelect }: AutocompleteDropdownProps) {
  if (suggestions.length === 0) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        borderRadius: "8px",
        overflow: "hidden",
        zIndex: 20,
        maxHeight: 320,
        overflowY: "auto",
      }}
    >
      <List dense disablePadding>
        {suggestions.map((s, i) => (
          <div key={s.id}>
            {i > 0 && <Divider component="li" />}
            <ListItem disablePadding>
              <ListItemButton onClick={() => onSelect(s)} sx={{ px: 2, py: 1 }}>
                <ListItemIcon sx={{ minWidth: 36 }}>{iconByType[s.type]}</ListItemIcon>
                <ListItemText
                  primary={s.label}
                  secondary={s.sublabel}
                  primaryTypographyProps={{ fontSize: 14, fontWeight: 400 }}
                  secondaryTypographyProps={{ fontSize: 12 }}
                />
              </ListItemButton>
            </ListItem>
          </div>
        ))}
      </List>
    </Paper>
  );
}
