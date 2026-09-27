"use client";

import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import CheckIcon from "@mui/icons-material/Check";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import SortIcon from "@mui/icons-material/Sort";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { DistanceReference } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ExploreTravelTimeControl } from "./ExploreTravelTimeControl";

type ResultSort = "relevance" | "distance";

interface CategoryResultsHeaderProps {
  count: number | null;
  isTransit: boolean;
  sort: ResultSort;
  onSort: (sort: ResultSort) => void;
  distanceReference: DistanceReference | null;
  showTravelTime: boolean;
  showMapUpdate: boolean;
  autoRefresh: boolean;
  onAutoRefresh: (checked: boolean) => void;
  adHocLabel?: string | null;
  attributions: Attribution[] | null | undefined;
}

/** Stable header: controls stay mounted while the result query loads or fails. */
export function CategoryResultsHeader({
  count,
  isTransit,
  sort,
  onSort,
  distanceReference,
  showTravelTime,
  showMapUpdate,
  autoRefresh,
  onAutoRefresh,
  adHocLabel,
  attributions,
}: CategoryResultsHeaderProps) {
  const ts = useTranslations("search");
  const tc = useTranslations("common");
  const [sortAnchor, setSortAnchor] = useState<HTMLElement | null>(null);
  const canSort = !isTransit && count !== null && count > 0;

  useEffect(() => {
    if (!canSort) setSortAnchor(null);
  }, [canSort]);

  const chooseSort = (value: ResultSort) => {
    onSort(value);
    setSortAnchor(null);
  };

  return (
    <Box
      sx={{
        px: 2,
        pt: 0.5,
        pb: 1,
        position: "relative",
        "&::after": {
          content: '""',
          position: "absolute",
          bottom: 0,
          left: 16,
          right: 16,
          borderBottom: "1px solid",
          borderColor: "divider",
        },
      }}
    >
      {adHocLabel && count !== null && (
        <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: "anywhere", mb: 0.5 }}>
          {adHocLabel}
        </Typography>
      )}
      {count !== null && (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            minWidth: 0,
          }}
        >
          <Typography
            variant="subtitle2"
            sx={{ fontWeight: 700, minWidth: 0, overflowWrap: "anywhere" }}
          >
            {isTransit ? tc("stopsCount", { count }) : tc("resultsCount", { count })}
          </Typography>
          {canSort && (
            <>
              <Button
                size="small"
                color="inherit"
                aria-label={`${ts("sortShownResults")}: ${sort === "distance" ? ts("sortDistance") : ts("sortRelevance")}`}
                aria-haspopup="menu"
                aria-expanded={Boolean(sortAnchor)}
                aria-controls={sortAnchor ? "category-results-sort-menu" : undefined}
                onClick={(event) => setSortAnchor(event.currentTarget)}
                startIcon={<SortIcon sx={{ fontSize: 17 }} />}
                endIcon={<ArrowDropDownIcon sx={{ fontSize: 18 }} />}
                sx={{
                  minWidth: 0,
                  flexShrink: 0,
                  px: 0.5,
                  textTransform: "none",
                  fontWeight: 500,
                  color: "text.secondary",
                  "@media (pointer: coarse)": { minHeight: 48 },
                }}
              >
                {sort === "distance" ? ts("sortDistance") : ts("sortRelevance")}
              </Button>
              <Menu
                id="category-results-sort-menu"
                anchorEl={sortAnchor}
                open={Boolean(sortAnchor)}
                onClose={() => setSortAnchor(null)}
                slotProps={{ list: { "aria-label": ts("sortShownResults") } }}
              >
                <MenuItem
                  role="menuitemradio"
                  aria-checked={sort === "relevance"}
                  selected={sort === "relevance"}
                  onClick={() => chooseSort("relevance")}
                >
                  <Box component="span" sx={{ width: 24, display: "inline-flex" }}>
                    {sort === "relevance" && <CheckIcon fontSize="small" />}
                  </Box>
                  {ts("sortRelevance")}
                </MenuItem>
                <MenuItem
                  role="menuitemradio"
                  aria-checked={sort === "distance"}
                  selected={sort === "distance"}
                  disabled={!distanceReference}
                  onClick={() => chooseSort("distance")}
                >
                  <Box component="span" sx={{ width: 24, display: "inline-flex" }}>
                    {sort === "distance" && <CheckIcon fontSize="small" />}
                  </Box>
                  {ts("sortDistance")}
                </MenuItem>
              </Menu>
            </>
          )}
        </Box>
      )}
      {!isTransit && count !== null && distanceReference && (
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            gap: 0.5,
            color: "text.secondary",
            mt: 0.25,
            minWidth: 0,
          }}
        >
          <PlaceOutlinedIcon sx={{ fontSize: 15, mt: "2px", flexShrink: 0 }} />
          <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
            {distanceReference.kind === "user_location"
              ? ts("distanceFromUserLocation")
              : distanceReference.kind === "search_area_center"
                ? ts("distanceFromAreaCenter")
                : distanceReference.name
                  ? ts("distanceFromOrigin", { name: distanceReference.name })
                  : ts("distanceFromSearchLocation")}
          </Typography>
        </Box>
      )}
      {showTravelTime && (
        <Box sx={{ mt: count !== null ? 0.75 : 0 }}>
          <ExploreTravelTimeControl />
        </Box>
      )}
      {showMapUpdate && (
        <Box
          component="label"
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 1,
            minHeight: 40,
            cursor: "pointer",
            mt: count !== null || showTravelTime ? 0.5 : 0,
            "@media (pointer: coarse)": { minHeight: 48 },
          }}
        >
          <Typography variant="body2" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {ts("updateOnMapMove")}
          </Typography>
          <Switch
            size="small"
            checked={autoRefresh}
            onChange={(event) => onAutoRefresh(event.target.checked)}
          />
        </Box>
      )}
      {attributions && attributions.length > 0 && (
        <Box sx={{ mt: 0.5, minWidth: 0 }}>
          <AttributionStrip
            attributions={attributions}
            variant="plain"
            label={tc("dataSources")}
            maxVisible={isTransit ? undefined : 3}
          />
        </Box>
      )}
    </Box>
  );
}
