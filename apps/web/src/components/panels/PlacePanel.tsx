"use client";

import Paper from "@mui/material/Paper";
import {
  useCategorySearchStore,
  useDataSourceStore,
  useMergedPlace,
  usePlaceStore,
} from "@openmapx/core";
import { useEffect, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";
import { PlaceDetailContent } from "./place/PlaceDetailContent";

export function PlacePanel() {
  const { selectedPlace, setSidePanelCollapsed } = usePlaceStore();
  const { activeCategory } = useCategorySearchStore();
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const [collapsed, setCollapsed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    setCollapsed(false);
  }, [selectedPlace?.id]);

  useEffect(() => {
    setSidePanelCollapsed(collapsed);
  }, [collapsed, setSidePanelCollapsed]);

  useEffect(() => {
    return () => setSidePanelCollapsed(false);
  }, [setSidePanelCollapsed]);

  const { place, isLoading } = useMergedPlace(selectedPlace);

  // When a category or data source is active, the floating card handles place display
  if (!place || activeCategory !== null || activeSource !== null) return null;

  return (
    <>
      <Paper
        elevation={0}
        sx={{
          position: "absolute",
          bottom: { xs: 0, sm: "auto" },
          top: { xs: "auto", sm: 0 },
          left: 0,
          right: { xs: 0, sm: "auto" },
          width: { xs: "100%", sm: PANEL_WIDTH },
          height: { xs: "auto", sm: "100dvh" },
          maxHeight: { xs: "60dvh", sm: "none" },
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
        }}
      >
        <PlaceDetailContent place={place} isLoading={isLoading} clearSearchBar />
      </Paper>

      <SidebarCollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
    </>
  );
}
