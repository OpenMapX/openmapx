"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tooltip from "@mui/material/Tooltip";
import { useCategorySearchStore, usePlaceDetails, usePlaceStore } from "@openmapx/core";
import { useEffect, useState } from "react";
import { PlaceDetailContent } from "./place/PlaceDetailContent";

const PANEL_WIDTH = 400;

export function PlacePanel() {
  const { selectedPlace } = usePlaceStore();
  const { activeCategory } = useCategorySearchStore();
  const [collapsed, setCollapsed] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    setCollapsed(false);
  }, [selectedPlace?.id]);

  const { data: details, isLoading } = usePlaceDetails(
    selectedPlace?.id ?? null,
    selectedPlace?.coordinates,
    selectedPlace?.name,
  );

  const place = details ?? selectedPlace;

  // When a category is active, the floating card handles place display instead
  if (!place || activeCategory !== null) return null;

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

      <Tooltip title={collapsed ? "Show sidebar" : "Hide sidebar"} placement="right">
        <IconButton
          onClick={() => setCollapsed((c) => !c)}
          size="small"
          sx={{
            display: { xs: "none", sm: "flex" },
            alignItems: "center",
            justifyContent: "center",
            position: "absolute",
            top: "50%",
            left: collapsed ? 0 : PANEL_WIDTH,
            transform: "translateY(-50%)",
            transition: "left 0.25s ease",
            zIndex: 9,
            bgcolor: "background.paper",
            borderRadius: "0 6px 6px 0",
            boxShadow: "2px 2px 8px rgba(0,0,0,0.15)",
            width: 20,
            height: 48,
            padding: 0,
            "&:hover": { bgcolor: "grey.50" },
          }}
          aria-label={collapsed ? "Show sidebar" : "Hide sidebar"}
        >
          {collapsed ? (
            <ChevronRightIcon sx={{ fontSize: 16 }} />
          ) : (
            <ChevronLeftIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </>
  );
}
