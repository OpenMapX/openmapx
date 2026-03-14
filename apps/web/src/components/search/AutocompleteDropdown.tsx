"use client";

import CategoryIcon from "@mui/icons-material/Category";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import SearchIcon from "@mui/icons-material/Search";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import type { AutocompleteResult } from "@openmapx/core";
import { isTransitName } from "@openmapx/core";

interface AutocompleteDropdownProps {
  suggestions: AutocompleteResult[];
  onSelect: (result: AutocompleteResult) => void;
}

const iconByType: Record<AutocompleteResult["type"], React.ReactNode> = {
  address: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  poi: <SearchIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  street: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  region: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  category: <CategoryIcon sx={{ fontSize: 20, color: "#007b8b" }} />,
  transit_stop: <DirectionsTransitIcon sx={{ fontSize: 20, color: "#007b8b" }} />,
};

function CategorySvgIcon({ path }: { path: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="#007b8b"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function getResultIcon(s: AutocompleteResult): React.ReactNode {
  if (s.iconPath) return <CategorySvgIcon path={s.iconPath} />;

  // Transit stop detection by keywords in label/sublabel
  const text = `${s.label} ${s.sublabel ?? ""}`.toLowerCase();
  if (isTransitName(text)) {
    return <DirectionsTransitIcon sx={{ fontSize: 20, color: "#007b8b" }} />;
  }

  return iconByType[s.type];
}

export function AutocompleteDropdown({ suggestions, onSelect }: AutocompleteDropdownProps) {
  if (suggestions.length === 0) return null;

  const deduped = suggestions.filter((s, i, arr) => arr.findIndex((x) => x.id === s.id) === i);

  return (
    <List dense disablePadding>
      {deduped.map((s, i) => (
        <li key={s.id} style={{ listStyle: "none" }}>
          {i > 0 && <Divider />}
          <ListItemButton onClick={() => onSelect(s)} sx={{ px: 2, py: 1 }}>
            <ListItemIcon sx={{ minWidth: 36 }}>{getResultIcon(s)}</ListItemIcon>
            <ListItemText
              primary={s.label}
              secondary={s.sublabel}
              primaryTypographyProps={{ fontSize: 14, fontWeight: 400 }}
              secondaryTypographyProps={{ fontSize: 12 }}
            />
          </ListItemButton>
        </li>
      ))}
    </List>
  );
}
