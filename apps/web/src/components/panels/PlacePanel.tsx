"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import StarIcon from "@mui/icons-material/Star";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { usePlaceDetails, usePlaceStore } from "@openmapx/core";
import { useEffect, useState } from "react";
import { PlaceInfoTab } from "./place/PlaceInfoTab";
import { PlaceOverviewTab } from "./place/PlaceOverviewTab";
import { PlaceReviewsTab } from "./place/PlaceReviewsTab";

const PANEL_WIDTH = 400;

export function PlacePanel() {
  const { selectedPlace } = usePlaceStore();
  const [tab, setTab] = useState(0);
  const [collapsed, setCollapsed] = useState(false);

  // Reset tab and re-expand whenever a different place is selected.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    setTab(0);
    setCollapsed(false);
  }, [selectedPlace?.id]);

  const { data: details, isLoading } = usePlaceDetails(
    selectedPlace?.id ?? null,
    selectedPlace?.coordinates,
    selectedPlace?.name,
  );

  // Show stub data immediately; overlay enriched data when the fetch resolves
  const place = details ?? selectedPlace;

  if (!place) return null;

  return (
    <>
      {/* Panel — slides off-screen on desktop when collapsed */}
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
        {/* Header image — only rendered when a photo is available */}
        {place.photos?.[0] && (
          <Box
            sx={{
              height: 220,
              position: "relative",
              flexShrink: 0,
              overflow: "hidden",
            }}
          >
            <Box
              component="img"
              src={place.photos[0].url}
              alt={place.name}
              onError={(e) => {
                const container = (e.currentTarget as HTMLImageElement).parentElement;
                if (container) container.style.display = "none";
              }}
              sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
            <Box
              sx={{
                position: "absolute",
                bottom: 4,
                right: 6,
                bgcolor: "rgba(0,0,0,0.35)",
                borderRadius: 0.5,
                px: 0.75,
                py: 0.25,
              }}
            >
              <Box
                component="span"
                sx={{
                  fontSize: 10,
                  color: "rgba(255,255,255,0.85)",
                  lineHeight: 1,
                  display: "block",
                }}
              >
                {place.photos[0].attribution}
              </Box>
            </Box>
          </Box>
        )}

        {/* Place name, rating, category — always visible above the tabs */}
        {/* On desktop, add top padding when there's no photo to clear the search bar (top:12 + height:48 = 60px) */}
        <Box sx={{ px: 2, pt: { xs: 2, sm: place.photos?.[0] ? 2 : "72px" }, pb: 1 }}>
          <Typography variant="h6" fontWeight={600} gutterBottom>
            {place.name}
          </Typography>
          {place.rating && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 0.75 }}>
              <Typography variant="body2" fontWeight={600}>
                {place.rating.toFixed(1)}
              </Typography>
              <StarIcon sx={{ fontSize: 16, color: "#FBBC04" }} />
              <Typography variant="body2" color="text.secondary">
                ({place.reviewCount?.toLocaleString()})
              </Typography>
            </Box>
          )}
          {place.category && (
            <Chip label={place.category} size="small" sx={{ borderRadius: "4px", fontSize: 12 }} />
          )}
        </Box>

        {/* Tabs */}
        <Tabs
          value={tab}
          onChange={(_, v: number) => setTab(v)}
          sx={{
            position: "sticky",
            top: 0,
            bgcolor: "background.paper",
            zIndex: 1,
            minHeight: 48,
            "& .MuiTabs-flexContainer": { justifyContent: "space-evenly" },
            "& .MuiTab-root": {
              textTransform: "none",
              fontSize: 14,
              fontWeight: 500,
              minHeight: 48,
              minWidth: "auto",
              color: "#5f6368",
            },
            "& .Mui-selected": { color: "#007b8b !important" },
            // Indicator only as wide as the tab label text.
            // MUI Tab has 16px horizontal padding on each side (32px total),
            // so calc(100% - 32px) = the text width.
            "& .MuiTabs-indicator": {
              height: 3,
              display: "flex",
              justifyContent: "center",
              backgroundColor: "transparent",
              "&::after": {
                content: '""',
                display: "block",
                width: "calc(100% - 32px)",
                backgroundColor: "#007b8b",
                borderRadius: "2px 2px 0 0",
              },
            },
            borderBottom: "1px solid rgba(0,0,0,0.1)",
          }}
        >
          <Tab label="Overview" />
          <Tab label="Reviews" />
          <Tab label="Info" />
        </Tabs>

        {tab === 0 && (
          <PlaceOverviewTab
            place={place}
            isLoading={isLoading}
            onNavigateToInfo={() => setTab(2)}
          />
        )}
        {tab === 1 && <PlaceReviewsTab place={place} />}
        {tab === 2 && <PlaceInfoTab place={place} isLoading={isLoading} />}
      </Paper>

      {/* Desktop-only collapse/expand toggle at the panel's right edge */}
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
