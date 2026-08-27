"use client";

import BookmarkIcon from "@mui/icons-material/Bookmark";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import DirectionsIcon from "@mui/icons-material/Directions";
import SearchIcon from "@mui/icons-material/Search";
import ShareIcon from "@mui/icons-material/Share";
import Box from "@mui/material/Box";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import {
  PANEL,
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
import { shareCurrentUrl } from "@/lib/deepLink";
import { BRAND, BRAND_LIGHT } from "@/lib/theme";

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  filled?: boolean;
  onClick?: () => void;
}

function ActionButton({ icon, label, filled = false, onClick }: ActionButtonProps) {
  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 0.75,
        cursor: "pointer",
        minWidth: 40,
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
}

export function PlaceActionButtons({ place }: Props) {
  const t = useTranslations("place");
  const [snackbar, setSnackbar] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const { setWaypoint, open: openDirections } = useDirectionsStore();
  const { setSelectedPlace } = usePlaceStore();
  const { data: session } = useSession();
  const { data: savedInListIds } = useIsSaved(session?.user ? place.id : null);
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

  return (
    <>
      <Box sx={{ display: "flex", justifyContent: "space-around", py: 1 }}>
        <ActionButton
          icon={<DirectionsIcon />}
          label={t("directions")}
          filled
          onClick={handleDirections}
        />
        <ActionButton
          icon={isSaved ? <BookmarkIcon /> : <BookmarkBorderIcon />}
          label={isSaved ? t("savedPlace") : t("savePlace")}
          filled={isSaved}
          onClick={() => {
            if (!session?.user) {
              setAuthOpen(true);
            } else {
              setSaveOpen(true);
            }
          }}
        />
        <ActionButton icon={<SearchIcon />} label={t("nearby")} onClick={handleNearby} />
        <ActionButton icon={<ShareIcon />} label={t("share")} onClick={handleShare} />
      </Box>

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
