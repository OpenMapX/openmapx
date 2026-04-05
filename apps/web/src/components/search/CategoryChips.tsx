"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import type { CategoryId } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useDataSources,
  useDirectionsStore,
  useIntegrationRegistry,
  useMapStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { TEAL } from "@/lib/theme";

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
  const { setQuery } = useSearchStore();
  const { isOpen: directionsOpen } = useDirectionsStore();
  const zoom = useMapStore((s) => s.zoom);
  const { activeSource, toggleSource, setActiveSource } = useDataSourceStore();
  const { data: sourcesData } = useDataSources();
  const registry = useIntegrationRegistry();

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

  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);

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

  const hidden = directionsOpen || activeCategory || activeSource;
  const zoomedOut = zoom < 9;

  if (hidden) return null;

  const FADE = 24;
  const leftEdge = canScrollLeft ? "transparent" : "black";
  const leftStop = canScrollLeft ? `black ${FADE}px` : "black 0px";
  const mask = `linear-gradient(to right, ${leftEdge}, ${leftStop}, black calc(100% - ${FADE}px), transparent)`;

  const chipSx = (isActive: boolean) =>
    ({
      height: 36,
      borderRadius: "18px",
      fontWeight: 500,
      fontSize: 13,
      bgcolor: isActive ? TEAL : "background.paper",
      color: isActive ? "#fff" : "text.primary",
      borderColor: isActive ? TEAL : "var(--omx-border)",
      boxShadow: isActive ? "none" : "0 1px 3px var(--omx-shadow-soft)",
      cursor: "pointer",
      userSelect: "none",
      flexShrink: 0,
      "& .MuiChip-icon": {
        color: "inherit",
        ml: "10px",
        mr: "-4px",
      },
      "&&:hover": {
        bgcolor: isActive ? "var(--omx-teal-hover)" : "var(--omx-chip-hover)",
      },
    }) as const;

  const chipIcon = (iconPath: string | undefined): React.ReactElement | undefined =>
    iconPath ? (
      <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
        <SvgIcon path={iconPath} />
      </Box>
    ) : undefined;

  return (
    <Box
      ref={scrollRef}
      sx={{
        position: "absolute",
        top: { xs: 72, sm: 18 },
        left: { xs: 0, sm: 420 },
        right: { xs: 0, sm: 108 },
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        px: { xs: 1, sm: 0 },
        overflowX: "auto",
        overflowY: "hidden",
        scrollbarWidth: "none",
        "&::-webkit-scrollbar": { display: "none" },
        maskImage: mask,
        WebkitMaskImage: mask,
        py: "2px",
        opacity: zoomedOut ? 0 : 1,
        pointerEvents: zoomedOut ? "none" : "auto",
        transition: "opacity 0.2s ease",
      }}
    >
      <Box sx={{ display: "flex", gap: 1, flexShrink: 0 }}>
        {(sourcesData?.sources ?? []).map((source) => {
          const isActive = activeSource === source.id;
          return (
            <Chip
              key={source.id}
              icon={chipIcon(dataSourceIcons(source.id))}
              label={source.categoryChipLabel}
              onClick={() => handleSourceClick(source.id, source.categoryChipLabel, isActive)}
              variant={isActive ? "filled" : "outlined"}
              color={isActive ? "primary" : "default"}
              sx={chipSx(isActive)}
            />
          );
        })}
        {CATEGORY_DEFINITIONS.filter((cat) => cat.showInChipBar).map((cat) => {
          const isActive = activeCategory === cat.id;
          return (
            <Chip
              key={cat.id}
              label={cat.label}
              icon={chipIcon(cat.iconPath)}
              onClick={() => handleCategoryClick(cat.id, cat.label, isActive)}
              variant={isActive ? "filled" : "outlined"}
              sx={chipSx(isActive)}
            />
          );
        })}
      </Box>
    </Box>
  );
}
