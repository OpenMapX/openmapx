"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import { useTheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { CategoryDefinition, CategoryId } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useDataSources,
  useDirectionsStore,
  useMapStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { floatingChipSx, floatingToolbarSx } from "./floatingChipSx";

type SourceChip = { id: string; categoryChipLabel: string };
type DiscoveryChip =
  | { kind: "category"; category: CategoryDefinition }
  | { kind: "source"; source: SourceChip };

const FIRST_CATEGORY_IDS = ["restaurants", "hotels", "transit", "activities"] as const;
const TRANSPORT_SOURCE_IDS = [
  "bike-sharing",
  "scooter-sharing",
  "car-sharing",
  "parking",
  "ev-charging",
  "fuel",
] as const;

function discoveryChips(sources: SourceChip[]): DiscoveryChip[] {
  const categories = CATEGORY_DEFINITIONS.filter((category) => category.showInChipBar);
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const sourceById = new Map<string, SourceChip>();
  for (const source of sources) {
    const existing = sourceById.get(source.id);
    if (!existing || source.categoryChipLabel.localeCompare(existing.categoryChipLabel) < 0) {
      sourceById.set(source.id, source);
    }
  }

  const ordered: DiscoveryChip[] = [];
  for (const id of FIRST_CATEGORY_IDS) {
    const category = categoryById.get(id);
    if (category) ordered.push({ kind: "category", category });
  }
  for (const id of TRANSPORT_SOURCE_IDS) {
    const source = sourceById.get(id);
    if (source) ordered.push({ kind: "source", source });
  }
  for (const category of categories) {
    if (!FIRST_CATEGORY_IDS.some((id) => id === category.id)) {
      ordered.push({ kind: "category", category });
    }
  }
  for (const source of [...sourceById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!TRANSPORT_SOURCE_IDS.some((id) => id === source.id)) {
      ordered.push({ kind: "source", source });
    }
  }
  return ordered;
}

function SvgIcon({ path, size = 16 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export function CategoryChips() {
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const textSearchActive = useCategorySearchStore((s) => s.mode === "text");
  const { setQuery } = useSearchStore();
  const { isOpen: directionsOpen } = useDirectionsStore();
  const zoom = useMapStore((s) => s.zoom);
  const { activeSource, toggleSource, setActiveSource } = useDataSourceStore();
  const { data: sourcesData } = useDataSources();
  const registry = useIntegrationRegistry();
  const chips = discoveryChips(sourcesData?.sources ?? []);

  // Build icon path lookup from data source integration manifests
  const dataSourceIcons = useCallback(
    (sourceId: string): string | undefined => {
      const all = registry.getAll();
      const match = all.find(
        (i) =>
          i.frontend?.searchCategory &&
          (i.frontend.searchCategory as { id: string }).id === sourceId,
      );
      return (match?.frontend?.searchCategory as { iconPath?: string })?.iconPath;
    },
    [registry],
  );

  const handleSourceClick = useCallback(
    (sourceId: string, label: string, isActive: boolean) => {
      if (isActive) {
        toggleSource(sourceId);
        setQuery("");
        useSidebarStore.getState().closeSidebar();
      } else {
        clearCategory();
        toggleSource(sourceId);
        setQuery(label);
        useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
      }
    },
    [toggleSource, setQuery, clearCategory],
  );

  const handleCategoryClick = useCallback(
    (catId: CategoryId, label: string, isActive: boolean) => {
      if (isActive) {
        clearCategory();
        setQuery("");
        useSidebarStore.getState().closeSidebar();
      } else {
        setActiveSource(null);
        setActiveCategory(catId);
        setQuery(label);
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      }
    },
    [clearCategory, setQuery, setActiveSource, setActiveCategory],
  );

  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const scrollRef = useRef<HTMLDivElement>(null);
  const [chipsEl, setChipsEl] = useState<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);

  // Stable identity: an inline arrow would detach and re-attach the row on
  // every render, costing an extra pass through the measured registration.
  const setRowRef = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setChipsEl(el);
  }, []);

  const updateScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 0);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    return () => el.removeEventListener("scroll", updateScrollState);
  }, [updateScrollState]);

  const hidden = directionsOpen || activeCategory || activeSource || textSearchActive;
  const zoomedOut = zoom < 9;

  // The chip row only lies across the map on mobile; on desktop it floats in
  // the margin beside the rail, whose own inset already frames the camera clear
  // of that side. Zoomed out the row is faded rather than unmounted, so it is
  // still measurable while covering nothing. Registered above the early return
  // so the hook runs on every render — the value, not the call site, decides
  // whether anything registers.
  useMeasuredMapObstruction("category-chips", "top", isMobile && !zoomedOut ? chipsEl : null);

  if (hidden) return null;

  const FADE = 24;
  const leftEdge = canScrollLeft ? "transparent" : "black";
  const leftStop = canScrollLeft ? `black ${FADE}px` : "black 0px";
  const mask = `linear-gradient(to right, ${leftEdge}, ${leftStop}, black calc(100% - ${FADE}px), transparent)`;

  const chipSx = (isActive: boolean) => floatingChipSx(isActive, "category");

  const chipIcon = (iconPath: string | undefined): React.ReactElement | undefined =>
    iconPath ? (
      <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
        <SvgIcon path={iconPath} />
      </Box>
    ) : undefined;

  return (
    <Box
      ref={setRowRef}
      sx={{
        ...floatingToolbarSx,
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
        maskImage: mask,
        WebkitMaskImage: mask,
        opacity: zoomedOut ? 0 : 1,
        pointerEvents: zoomedOut ? "none" : "auto",
        transition: "opacity 0.2s ease",
      }}
    >
      <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
        {chips.map((chip) => {
          if (chip.kind === "source") {
            const { source } = chip;
            const isActive = activeSource === source.id;
            return (
              <Chip
                key={`source:${source.id}`}
                icon={chipIcon(dataSourceIcons(source.id))}
                label={source.categoryChipLabel}
                onClick={() => handleSourceClick(source.id, source.categoryChipLabel, isActive)}
                variant={isActive ? "filled" : "outlined"}
                color={isActive ? "primary" : "default"}
                sx={chipSx(isActive)}
              />
            );
          }
          const { category } = chip;
          const isActive = activeCategory === category.id;
          return (
            <Chip
              key={`category:${category.id}`}
              label={category.label}
              icon={chipIcon(category.iconPath)}
              onClick={() => handleCategoryClick(category.id, category.label, isActive)}
              variant={isActive ? "filled" : "outlined"}
              sx={chipSx(isActive)}
            />
          );
        })}
      </Box>
    </Box>
  );
}
