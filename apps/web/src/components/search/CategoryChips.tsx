"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
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
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMeasuredMapObstruction } from "@/lib/mapObstructions";
import { prefersReducedMotion } from "@/lib/reducedMotion";
import { floatingChipSx, floatingToolbarSx } from "./floatingChipSx";

const FINE_POINTER = "@media (hover: hover) and (pointer: fine)";
const TOUCH_FADE = 24;
/** Wide enough to fade the chips out behind a 32px arrow. */
const ARROW_FADE = 48;
/** Share of the visible row one arrow click scrolls, leaving a chip in view for context. */
const PAGE_FRACTION = 0.8;

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
  const t = useTranslations("search");
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
  const [canScrollRight, setCanScrollRight] = useState(false);

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
    // Fractional scroll positions on zoomed or high-DPI screens stop a pixel short of the end.
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Chips arrive as data sources load and the row resizes with the window, so
  // both can change what lies past either edge without a scroll event.
  useEffect(() => {
    const el = chipsEl;
    if (!el) return;
    updateScrollState();
    el.addEventListener("scroll", updateScrollState, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateScrollState);
    observer?.observe(el);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", updateScrollState);
      observer?.disconnect();
    };
  }, [chipsEl, updateScrollState]);

  const scrollByPage = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    let target = el.scrollLeft + direction * el.clientWidth * PAGE_FRACTION;
    // Go all the way rather than leave a sliver that would take a click of its own.
    const sliver = el.clientWidth * (1 - PAGE_FRACTION);
    if (target > max - sliver) target = max;
    if (target < sliver) target = 0;
    el.scrollTo({ left: target, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

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

  // Each edge fades only while more chips lie beyond it. Where an arrow sits
  // on the edge the fade widens so the chips don't show through behind it.
  const edgeMask = (fade: number) => {
    const left = canScrollLeft ? `transparent, black ${fade}px` : "black, black 0px";
    const right = canScrollRight
      ? `black calc(100% - ${fade}px), transparent`
      : "black 100%, black";
    return `linear-gradient(to right, ${left}, ${right})`;
  };
  const touchMask = edgeMask(TOUCH_FADE);
  const arrowMask = edgeMask(ARROW_FADE);

  const arrowSx = (side: "left" | "right") => ({
    position: "absolute",
    top: "50%",
    [side]: 0,
    transform: "translateY(-50%)",
    width: 32,
    height: 32,
    bgcolor: "background.paper",
    border: "1px solid var(--omx-border)",
    boxShadow: "0 1px 3px var(--omx-shadow-soft)",
    "&:hover": { bgcolor: "var(--omx-chip-hover)" },
    display: "none",
    [FINE_POINTER]: { display: "inline-flex" },
  });

  const chipSx = (isActive: boolean) => floatingChipSx(isActive, "category");

  const chipIcon = (iconPath: string | undefined): React.ReactElement | undefined =>
    iconPath ? (
      <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
        <SvgIcon path={iconPath} />
      </Box>
    ) : undefined;

  return (
    <Box
      sx={{
        ...floatingToolbarSx,
        px: 0,
        py: 0,
        opacity: zoomedOut ? 0 : 1,
        pointerEvents: zoomedOut ? "none" : "auto",
        transition: "opacity 0.2s ease",
      }}
    >
      <Box
        ref={setRowRef}
        sx={{
          flex: 1,
          minWidth: 0,
          px: floatingToolbarSx.px,
          py: floatingToolbarSx.py,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
          "&::-webkit-scrollbar": { display: "none" },
          maskImage: touchMask,
          WebkitMaskImage: touchMask,
          [FINE_POINTER]: { maskImage: arrowMask, WebkitMaskImage: arrowMask },
        }}
      >
        {/* Sized to its chips, so the resize observer sees late chips arrive. */}
        <Box sx={{ display: "flex", gap: 1, width: "max-content" }}>
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
      {/* A mouse can't swipe the row, so pointer devices get arrows; touch
        screens keep the fade alone. Out of the tab order: keyboard users reach
        every chip by tabbing, which scrolls it into view. */}
      {canScrollLeft && (
        <IconButton
          size="small"
          tabIndex={-1}
          aria-label={t("scrollCategoriesLeft")}
          onClick={() => scrollByPage(-1)}
          sx={arrowSx("left")}
        >
          <ChevronLeftIcon fontSize="small" />
        </IconButton>
      )}
      {canScrollRight && (
        <IconButton
          size="small"
          tabIndex={-1}
          aria-label={t("scrollCategoriesRight")}
          onClick={() => scrollByPage(1)}
          sx={arrowSx("right")}
        >
          <ChevronRightIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
