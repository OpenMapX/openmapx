"use client";

import BookmarkIcon from "@mui/icons-material/Bookmark";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DirectionsIcon from "@mui/icons-material/Directions";
import SearchIcon from "@mui/icons-material/Search";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  PANEL,
  savedPlaceKey,
  useCategorySearchStore,
  useDirectionsStore,
  useIsSaved,
  usePlaceStore,
  useSession,
  useSidebarStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useState } from "react";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { SavePlaceDialog } from "@/components/panels/saved/SavePlaceDialog";
import { BRAND, BRAND_LIGHT } from "@/integration-api/runtime/theme";
import { shareCurrentUrl } from "@/lib/deepLink";

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  filled?: boolean;
  onClick?: () => void;
}

function ActionButton({ icon, label, filled = false, onClick }: ActionButtonProps) {
  return (
    <Box
      component="button"
      type="button"
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        cursor: "pointer",
        minWidth: 40,
        border: 0,
        p: 0,
        bgcolor: "transparent",
        font: "inherit",
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: 3,
          borderRadius: 1,
        },
      }}
      onClick={onClick}
    >
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: "50%",
          bgcolor: filled ? BRAND : BRAND_LIGHT,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "filter 0.15s",
          "&:hover": { filter: "brightness(0.93)" },
          "& svg": { fontSize: 20, color: filled ? "#fff" : BRAND },
        }}
      >
        {icon}
      </Box>
      <Typography
        variant="caption"
        align="center"
        sx={{
          fontWeight: 500,
          color: BRAND,
          lineHeight: 1.3,
        }}
      >
        {label}
      </Typography>
    </Box>
  );
}

interface Props {
  place: Place;
  /**
   * `circles`: icon circles with a label under each, spread across the panel.
   * `pills`: one scrollable row of labelled pills, the compact form a phone's
   * place sheet uses.
   */
  layout?: "circles" | "pills";
}

export function PlaceActionButtons({ place, layout = "circles" }: Props) {
  const t = useTranslations("place");
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { setWaypoint, open: openDirections } = useDirectionsStore();
  const { setSelectedPlace } = usePlaceStore();
  const { data: session } = useSession();
  const { data: savedInListIds } = useIsSaved(session?.user ? savedPlaceKey(place) : null);
  const isSaved = savedInListIds && savedInListIds.length > 0;

  const handleDirections = () => {
    const destinationIndex = useDirectionsStore.getState().waypoints.length - 1;
    setWaypoint(destinationIndex, place.coordinates, place.name);
    openDirections();
    setSelectedPlace(null);
    useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
  };

  const handleNearby = () => {
    setSelectedPlace(null);
    // Close the place-card detail panel so it doesn't linger in the deep-link
    // URL while the explore box (and subsequent results) take over.
    useSidebarStore.getState().closeDetail();
    useCategorySearchStore.getState().openExploreBox(place);
  };

  const handleShare = async () => {
    const result = await shareCurrentUrl({ title: place.name });
    if (result === "copied") setSnackbar(t("linkCopied"));
  };

  const actions: Array<ActionButtonProps & { key: string }> = [
    {
      key: "directions",
      icon: <DirectionsIcon />,
      label: t("directions"),
      filled: true,
      onClick: handleDirections,
    },
    {
      key: "save",
      icon: isSaved ? <BookmarkIcon /> : <BookmarkBorderIcon />,
      label: isSaved ? t("savedPlace") : t("savePlace"),
      filled: isSaved,
      onClick: () => (session?.user ? setSaveOpen(true) : setAuthOpen(true)),
    },
    { key: "nearby", icon: <SearchIcon />, label: t("nearby"), onClick: handleNearby },
    {
      key: "share",
      icon: <ShareIcon />,
      label: t("share"),
      onClick: () => void handleShare(),
    },
  ];

  return (
    <>
      {layout === "pills" ? (
        <Box
          sx={{
            display: "flex",
            gap: 1,
            py: 1,
            overflowX: "auto",
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          {actions.map((action) => (
            <Button
              key={action.key}
              variant={action.filled ? "contained" : "tonal"}
              startIcon={action.icon}
              onClick={action.onClick}
              sx={{ flexShrink: 0, height: 36, whiteSpace: "nowrap" }}
            >
              {action.label}
            </Button>
          ))}
        </Box>
      ) : (
        <Box sx={{ display: "flex", justifyContent: "space-around", py: 1 }}>
          {actions.map((action) => (
            <ActionButton
              key={action.key}
              icon={action.icon}
              label={action.label}
              filled={action.filled}
              onClick={action.onClick}
            />
          ))}
        </Box>
      )}

      <Snackbar
        open={snackbar !== null}
        autoHideDuration={2500}
        onClose={() => setSnackbar(null)}
        message={snackbar}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      />
      <SavePlaceDialog open={saveOpen} onClose={() => setSaveOpen(false)} place={place} />
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
