"use client";

import CloseIcon from "@mui/icons-material/Close";
import PlaceIcon from "@mui/icons-material/Place";
import SearchIcon from "@mui/icons-material/Search";
import Box from "@mui/material/Box";
import ClickAwayListener from "@mui/material/ClickAwayListener";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { AutocompleteResult, CategoryId } from "@openmapx/core";
import { CATEGORY_DEFINITIONS, useCategorySearchStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { launchExploreFromPlace, launchExploreTextSearch } from "@/lib/launchExplore";
import { useMap } from "@/lib/MapContext";

const FREETEXT_ID = "explore-freetext";

export function ExploreSearchBox() {
  const t = useTranslations("search");
  const tc = useTranslations("common");
  const { mapRef } = useMap();
  const exploreBoxOpen = useCategorySearchStore((s) => s.exploreBoxOpen);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const closeExploreBox = useCategorySearchStore((s) => s.closeExploreBox);
  const [input, setInput] = useState("");

  const query = input.trim();

  const suggestions = useMemo<AutocompleteResult[]>(() => {
    const cats = CATEGORY_DEFINITIONS.filter(
      (cat) =>
        cat.showInChipBar &&
        (query === "" || cat.label.toLowerCase().includes(query.toLowerCase())),
    ).map((cat) => ({
      id: `cat-${cat.id}`,
      label: cat.label,
      type: "category" as const,
      iconPath: cat.iconPath,
      rawCategory: cat.id,
    }));
    if (query === "") return cats;
    const freeText: AutocompleteResult = {
      id: FREETEXT_ID,
      label: t("searchFreeText", { query }),
      type: "poi",
    };
    return [freeText, ...cats];
  }, [query, t]);

  if (!exploreBoxOpen || !anchor) return null;

  const runText = () => {
    if (query.length > 0) launchExploreTextSearch(mapRef.current, anchor, query);
  };

  const handleSelect = (result: AutocompleteResult) => {
    if (result.id === FREETEXT_ID) {
      runText();
      return;
    }
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
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 1,
            px: 2,
            py: 1,
            borderBottom: "1px solid var(--omx-border)",
          }}
        >
          <SearchIcon sx={{ fontSize: 20, color: "text.secondary" }} />
          <InputBase
            autoFocus
            fullWidth
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runText();
            }}
            placeholder={t("searchNear")}
            sx={{ fontSize: 14 }}
          />
        </Box>
        <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
          <AutocompleteDropdown suggestions={suggestions} onSelect={handleSelect} />
        </Box>
      </Paper>
    </ClickAwayListener>
  );
}
