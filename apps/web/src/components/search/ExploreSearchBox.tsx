"use client";

import CloseIcon from "@mui/icons-material/Close";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, CategoryId } from "@openmapx/core";
import { CATEGORY_DEFINITIONS, useCategorySearchStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { launchExploreFromPlace } from "@/lib/launchExplore";
import { useMap } from "@/lib/MapContext";

export function ExploreSearchBox() {
  const t = useTranslations("search");
  const tc = useTranslations("common");
  const { mapRef } = useMap();
  const exploreBoxOpen = useCategorySearchStore((s) => s.exploreBoxOpen);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const closeExploreBox = useCategorySearchStore((s) => s.closeExploreBox);

  const suggestions = useMemo<AutocompleteResult[]>(
    () =>
      CATEGORY_DEFINITIONS.filter((cat) => cat.showInChipBar).map((cat) => ({
        id: `cat-${cat.id}`,
        label: cat.label,
        type: "category" as const,
        iconPath: cat.iconPath,
        rawCategory: cat.id,
      })),
    [],
  );

  if (!exploreBoxOpen || !anchor) return null;

  const handleSelect = (result: AutocompleteResult) => {
    const categoryId = result.rawCategory as CategoryId | undefined;
    if (!categoryId) return;
    launchExploreFromPlace(mapRef.current, anchor, categoryId, result.label);
  };

  return (
    <ClickAwayListener onClickAway={closeExploreBox}>
      <Paper
        elevation={6}
        sx={{
          position: "absolute",
          top: "calc(12px + var(--omx-safe-top))",
          left: { xs: "var(--omx-safe-left)", sm: "calc(12px + var(--omx-safe-left))" },
          width: { xs: "calc(100vw - 24px)", sm: 388 },
          zIndex: 1300,
          borderRadius: 2,
          overflow: "hidden",
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") closeExploreBox();
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1.25,
            borderBottom: "1px solid var(--omx-border)",
          }}
        >
          <PlaceIcon sx={{ fontSize: 20, color: "text.secondary" }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
              {t("searchNear")}
            </Typography>
            <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
              {anchor.name}
            </Typography>
          </Box>
          <IconButton size="small" onClick={closeExploreBox} aria-label={tc("close")}>
            <CloseIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Box>
        <Box sx={{ maxHeight: 360, overflowY: "auto" }}>
          <AutocompleteDropdown suggestions={suggestions} onSelect={handleSelect} />
        </Box>
      </Paper>
    </ClickAwayListener>
  );
}
