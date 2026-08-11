"use client";

import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CategoryIcon from "@mui/icons-material/Category";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import FlagIcon from "@mui/icons-material/Flag";
import HomeIcon from "@mui/icons-material/Home";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import SearchIcon from "@mui/icons-material/Search";
import WorkIcon from "@mui/icons-material/Work";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import type { AutocompleteResult } from "@openmapx/core";
import { isTransitRawCategory } from "@openmapx/core";
import { useEffect, useRef } from "react";
import { BRAND } from "@/lib/theme";
import { BrandLogo } from "./BrandLogo";
import { PresetIcon } from "./PresetIcon";

interface AutocompleteDropdownProps {
  suggestions: AutocompleteResult[];
  onSelect: (result: AutocompleteResult) => void;
  highlightedIndex?: number;
}

const labeledPlaceIcon: Record<string, React.ReactNode> = {
  home: <HomeIcon sx={{ fontSize: 20, color: BRAND }} />,
  work: <WorkIcon sx={{ fontSize: 20, color: BRAND }} />,
};

const iconByType: Record<AutocompleteResult["type"], React.ReactNode> = {
  address: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  poi: <SearchIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  street: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  region: <LocationOnIcon sx={{ fontSize: 20, color: "text.secondary" }} />,
  category: <CategoryIcon sx={{ fontSize: 20, color: BRAND }} />,
  transit_stop: <DirectionsTransitIcon sx={{ fontSize: 20, color: BRAND }} />,
  labeled_place: <FlagIcon sx={{ fontSize: 20, color: BRAND }} />,
  nlp_search: <AutoAwesomeIcon sx={{ fontSize: 20, color: BRAND }} />,
  brand: <CategoryIcon sx={{ fontSize: 20, color: BRAND }} />,
};

function CategorySvgIcon({ path }: { path: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill={BRAND}
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function getResultIcon(s: AutocompleteResult): React.ReactNode {
  if (s.type === "labeled_place" && s.labelKey) {
    return labeledPlaceIcon[s.labelKey] ?? iconByType.labeled_place;
  }

  if (s.type === "brand" && s.brand) {
    return <BrandLogo brand={s.brand} size={20} />;
  }

  if (s.iconPath) return <CategorySvgIcon path={s.iconPath} />;

  if (s.presetIconKey) return <PresetIcon iconKey={s.presetIconKey} size={20} />;

  // Use the authoritative rawCategory from the geocoder to decide whether a
  // result is transit infrastructure. The old label-keyword heuristic
  // false-fired on POIs whose names merely contain "Airport", "Bahnhof",
  // "Station" etc. (e.g. "Frankfurt Airport Center I" is an office building).
  if (s.type === "transit_stop" || (s.rawCategory && isTransitRawCategory(s.rawCategory))) {
    return <DirectionsTransitIcon sx={{ fontSize: 20, color: BRAND }} />;
  }

  return iconByType[s.type];
}

export function AutocompleteDropdown({
  suggestions,
  onSelect,
  highlightedIndex = -1,
}: AutocompleteDropdownProps) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (highlightedIndex >= 0) {
      activeRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  if (suggestions.length === 0) return null;

  return (
    <List dense disablePadding>
      {suggestions.map((s, i) => (
        <li
          key={`${s.id}-${s.type}-${s.sublabel ?? i}`}
          ref={i === highlightedIndex ? activeRef : undefined}
          style={{ listStyle: "none" }}
        >
          {i > 0 && <Divider />}
          <ListItemButton
            onClick={() => onSelect(s)}
            selected={i === highlightedIndex}
            sx={{ px: 2, py: 1 }}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>{getResultIcon(s)}</ListItemIcon>
            <ListItemText
              primary={s.label}
              secondary={s.sublabel}
              slotProps={{
                primary: { sx: { fontSize: 14, fontWeight: 400 } },
                secondary: { sx: { fontSize: 12 } },
              }}
            />
          </ListItemButton>
        </li>
      ))}
    </List>
  );
}
