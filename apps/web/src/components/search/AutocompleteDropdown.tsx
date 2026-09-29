"use client";

import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import CategoryIcon from "@mui/icons-material/Category";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import FlagIcon from "@mui/icons-material/Flag";
import HomeIcon from "@mui/icons-material/Home";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import SearchIcon from "@mui/icons-material/Search";
import WorkIcon from "@mui/icons-material/Work";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import type { AutocompleteResult, DistanceReference } from "@openmapx/core";
import {
  formatMeasurementDistance,
  isTransitRawCategory,
  normalizeSearchTerm,
  resultDistanceMetres,
  useSettingsStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import { BRAND } from "@/integration-api/runtime/theme";
import { BrandLogo } from "./BrandLogo";
import { PresetIcon } from "./PresetIcon";

interface AutocompleteDropdownProps {
  suggestions: AutocompleteResult[];
  onSelect: (result: AutocompleteResult) => void;
  highlightedIndex?: number;
  distanceReference?: DistanceReference | null;
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

// Provider sublabels are display strings, not structured addresses. Only
// remove complete, repeated comma-separated parts; keep every other part so
// equal names in different places still have their locality visible.
function conciseAddress(label: string, sublabel?: string): string | undefined {
  if (!sublabel) return undefined;
  const parts = sublabel.split(",").map((part) => part.trim());
  if (parts.length < 2 || parts.some((part) => !part)) return sublabel;

  const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase();
  const remaining = same(parts[0], label.trim()) ? parts.slice(1) : parts;
  const distinct = remaining.filter(
    (part, index) => index === 0 || !same(part, remaining[index - 1]),
  );
  if (remaining.length === parts.length && distinct.length === remaining.length) return sublabel;
  return distinct.join(", ") || undefined;
}

function resultDescription(s: AutocompleteResult, t: (key: string) => string): string | undefined {
  if (s.type === "category") return s.sublabel ?? t("searchCategory");
  if (s.type === "brand") {
    const action = t("searchBrand");
    return s.sublabel && s.sublabel !== action ? `${action} · ${s.sublabel}` : action;
  }

  const typeKeys: Partial<Record<AutocompleteResult["type"], string>> = {
    address: "resultTypeAddress",
    poi: "resultTypePlace",
    street: "resultTypeStreet",
    region: "resultTypeArea",
    transit_stop: "resultTypeStop",
  };
  const typeKey =
    s.rawCategory && isTransitRawCategory(s.rawCategory) ? "resultTypeStop" : typeKeys[s.type];
  if (!typeKey) return s.sublabel;

  const address = conciseAddress(s.label, s.sublabel);
  return address ? `${t(typeKey)} · ${address}` : t(typeKey);
}

export function AutocompleteDropdown({
  suggestions,
  onSelect,
  highlightedIndex = -1,
  distanceReference,
}: AutocompleteDropdownProps) {
  const t = useTranslations("search");
  const units = useSettingsStore((s) => s.units);
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (highlightedIndex >= 0) {
      activeRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  if (suggestions.length === 0) return null;

  return (
    <List dense disablePadding>
      {suggestions.map((s, i) => {
        const matchedValue = s.searchMatch?.value.trim();
        const showMatchedValue =
          Boolean(matchedValue) &&
          normalizeSearchTerm(matchedValue ?? "") !== normalizeSearchTerm(s.label);
        const description = resultDescription(s, t);
        const distance = resultDistanceMetres(distanceReference ?? null, s.coordinates);
        const distanceText =
          distance !== null &&
          s.type !== "category" &&
          s.type !== "brand" &&
          s.type !== "nlp_search"
            ? `${formatMeasurementDistance(distance, units)} ${t(
                distanceReference?.kind === "user_location" ? "fromYou" : "fromMapCenter",
              )}`
            : null;
        return (
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
                primary={
                  <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                    <Box component="span" sx={{ minWidth: 0 }}>
                      {s.label}
                    </Box>
                    {showMatchedValue && (
                      <Chip
                        label={matchedValue}
                        aria-label={`${t("matchedValue")}: ${matchedValue}`}
                        size="small"
                        variant="outlined"
                        sx={{
                          height: 20,
                          fontSize: 11,
                          flexShrink: 0,
                          "& .MuiChip-label": { px: 0.75 },
                        }}
                      />
                    )}
                  </Box>
                }
                secondary={[description, distanceText].filter(Boolean).join(" · ")}
                slotProps={{
                  primary: { sx: { fontSize: 14, fontWeight: 400 } },
                  secondary: { sx: { fontSize: 12 } },
                }}
              />
            </ListItemButton>
          </li>
        );
      })}
    </List>
  );
}
