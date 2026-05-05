"use client";

import CloseIcon from "@mui/icons-material/Close";
import StarIcon from "@mui/icons-material/Star";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { MergedRoute, Place, TransportMode } from "@openmapx/core";
import { usePlaceStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TEAL } from "@/lib/theme";
import { useFloatingMobileSheetHandle } from "../MobileBottomSheet";
import { LineDetail } from "../transit/LineDetail";
import { PlaceDeparturesView } from "../transit/PlaceDeparturesView";
import { PlaceTransitSection } from "../transit/PlaceTransitSection";
import { StopBoardView } from "../transit/StopBoardView";
import { StopInfrastructureSection } from "../transit/StopInfrastructureSection";
import { TripDetailView } from "../transit/TripDetailView";
import { PlaceInfoTab } from "./PlaceInfoTab";
import { PlaceOverviewTab } from "./PlaceOverviewTab";
import { PlacePhotoGallery } from "./PlacePhotoGallery";
import { PlacePhotoHero } from "./PlacePhotoHero";
import { PlaceReviewsTab } from "./PlaceReviewsTab";

interface Props {
  place: Place;
  isLoading: boolean;
  onClose?: () => void;
  /** Add top padding to the header to clear the floating search bar. True for the full sidebar. */
  clearSearchBar?: boolean;
}

export function PlaceDetailContent({ place, isLoading, onClose, clearSearchBar = false }: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const locale = useLocale();
  const [tab, setTab] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [showDepartures, setShowDepartures] = useState(false);
  const [departuresModeFilter, setDeparturesModeFilter] = useState<TransportMode | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<MergedRoute | null>(null);
  const [activeStopBoard, setActiveStopBoard] = useState<{ stopId: string; title: string } | null>(
    null,
  );
  const activeTripDep = usePlaceStore((s) => s.activeTripDep);
  const setActiveTripDep = usePlaceStore((s) => s.setActiveTripDep);
  const setActiveRouteId = usePlaceStore((s) => s.setActiveRouteId);

  // Sync active route into the store: TripDetailView takes priority over LineDetail
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    if (activeTripDep) {
      setActiveRouteId(activeTripDep.route.id);
    } else {
      setActiveRouteId(selectedRoute?.id ?? null);
    }
  }, [activeTripDep, selectedRoute]);

  // Reset tab when a different place loads
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger
  useEffect(() => {
    setTab(0);
    setGalleryOpen(false);
    setShowDepartures(false);
    setDeparturesModeFilter(null);
    setSelectedRoute(null);
    setActiveStopBoard(null);
    setActiveTripDep(null);
  }, [place.id]);

  // A Place represents a transit stop when the geocoder/synthetic builder
  // tagged it as such — makeSyntheticStopPlace + geocodeStopAsPlace always
  // set rawCategory = "transit_stop". Stop mode never renders the photo
  // hero, so suppress floating-handle mode there too.
  const isStopMode = place.rawCategory === "transit_stop";
  const placePhotos = place.photos ?? [];
  const hasPhoto =
    !isStopMode &&
    placePhotos.length > 0 &&
    (placePhotos[0].url.startsWith("https://") || placePhotos[0].url.startsWith("http://"));
  // When a photo hero is rendered as the first child, let the mobile sheet's
  // drag pill float over it so the image reaches the rounded sheet corners.
  // No-op on desktop and when no photo is available. Must be called before
  // any conditional return — hooks rules.
  useFloatingMobileSheetHandle(hasPhoto);

  // View priority: TripDetailView > LineDetail > StopBoardView > DeparturesView > StopMode > normal
  if (activeTripDep) {
    return (
      <TripDetailView
        departure={activeTripDep}
        onBack={() => setActiveTripDep(null)}
        clearSearchBar={clearSearchBar}
      />
    );
  }

  if (selectedRoute) {
    return (
      <LineDetail
        routeId={selectedRoute.id}
        routeHint={selectedRoute}
        place={place}
        onBack={() => setSelectedRoute(null)}
        clearSearchBar={clearSearchBar}
      />
    );
  }

  if (activeStopBoard) {
    return (
      <StopBoardView
        stopId={activeStopBoard.stopId}
        title={activeStopBoard.title}
        onBack={() => setActiveStopBoard(null)}
        clearSearchBar={clearSearchBar}
        onDepartureClick={(dep) => setActiveTripDep(dep)}
      />
    );
  }

  if (showDepartures) {
    return (
      <PlaceDeparturesView
        place={place}
        onBack={() => {
          setShowDepartures(false);
          setDeparturesModeFilter(null);
        }}
        clearSearchBar={clearSearchBar}
        modeFilter={departuresModeFilter}
        onDepartureClick={(dep) => setActiveTripDep(dep)}
      />
    );
  }

  if (isStopMode) {
    return (
      <Box>
        {/* Minimal stop header */}
        <Box
          sx={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            px: 2,
            pt: clearSearchBar ? { xs: 2, sm: "72px" } : 2,
            pb: 1,
          }}
        >
          <Typography variant="h6" fontWeight={600} sx={{ flex: 1, minWidth: 0, pr: 1 }}>
            {place.name}
          </Typography>
          {onClose && (
            <IconButton onClick={onClose} aria-label={tc("close")} size="small" sx={{ mt: -0.5 }}>
              <CloseIcon />
            </IconButton>
          )}
        </Box>
        {/* Transit section is the primary content */}
        <PlaceTransitSection
          place={place}
          onOpenDepartures={(mode) => {
            setDeparturesModeFilter(mode ?? null);
            setShowDepartures(true);
          }}
          onOpenLineDetail={(route) => {
            setDeparturesModeFilter(null);
            setSelectedRoute(route);
          }}
          onOpenTripDetail={(dep) => setActiveTripDep(dep)}
        />
        <StopInfrastructureSection
          place={place}
          onOpenStopBoard={(stopId, title) => setActiveStopBoard({ stopId, title })}
        />
      </Box>
    );
  }

  return (
    <>
      {/* Header photo with "View photos" */}
      {hasPhoto ? (
        <PlacePhotoHero
          photos={placePhotos}
          placeName={place.name}
          onClose={onClose}
          onViewPhotos={() => setGalleryOpen(true)}
        />
      ) : null}

      {/* Photo gallery modal */}
      <PlacePhotoGallery
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        placeName={place.name}
        placeId={place.id}
        lat={place.coordinates[1]}
        lng={place.coordinates[0]}
      />

      {/* Name / rating / category */}
      <Box
        sx={{
          px: 2,
          pt: clearSearchBar && !hasPhoto ? { xs: 2, sm: "72px" } : 2,
          pb: 1,
          position: "relative",
        }}
      >
        {/* Close button when there is no photo */}
        {onClose && !hasPhoto && (
          <IconButton
            onClick={onClose}
            aria-label={tc("close")}
            sx={{
              position: "absolute",
              top: clearSearchBar ? { xs: 8, sm: "72px" } : 8,
              right: 8,
              bgcolor: "background.paper",
              borderRadius: "50%",
              boxShadow: 2,
              p: 0.75,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <CloseIcon sx={{ fontSize: 24, color: "text.primary" }} />
          </IconButton>
        )}

        <Typography variant="h6" fontWeight={600} gutterBottom sx={{ pr: onClose ? 4 : 0 }}>
          {place.name}
        </Typography>
        {place.rating && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 0.75 }}>
            <Typography variant="body2" fontWeight={600}>
              {place.rating.toFixed(1)}
            </Typography>
            <StarIcon sx={{ fontSize: 16, color: "#FBBC04" }} />
            <Typography variant="body2" color="text.secondary">
              ({place.reviewCount?.toLocaleString(locale)})
            </Typography>
          </Box>
        )}
        {place.category && (
          <Chip
            label={place.category.toLowerCase() === "poi" ? "POI" : place.category}
            size="small"
            sx={{ borderRadius: "4px", fontSize: 12 }}
          />
        )}
      </Box>

      {/* Tabs */}
      <Tabs
        value={tab}
        onChange={(_, v: number) => setTab(v)}
        sx={(theme) => ({
          position: "sticky",
          top: 0,
          // Light mode: keep the tabs flush with the panel body (#fff on
          // #fff) — separation is handled by the bottom border below.
          // Dark mode: switch to background.default (#1c1c1c) so the tab
          // strip is visibly tinted off the body's #2d2d2d.
          bgcolor: "background.paper",
          ...theme.applyStyles("dark", { bgcolor: "background.default" }),
          zIndex: 1,
          minHeight: 48,
          "& .MuiTabs-flexContainer": { justifyContent: "space-evenly" },
          "& .MuiTab-root": {
            textTransform: "none",
            fontSize: 14,
            fontWeight: 500,
            minHeight: 48,
            minWidth: "auto",
            color: "text.secondary",
          },
          "& .Mui-selected": { color: `${TEAL} !important` },
          "& .MuiTabs-indicator": {
            height: 3,
            display: "flex",
            justifyContent: "center",
            backgroundColor: "transparent",
            "&::after": {
              content: '""',
              display: "block",
              width: "calc(100% - 32px)",
              backgroundColor: TEAL,
              borderRadius: "2px 2px 0 0",
            },
          },
          borderBottom: "1px solid var(--omx-border-light)",
        })}
      >
        <Tab label={t("overview")} />
        <Tab label={t("reviews")} />
        <Tab label={t("info")} />
      </Tabs>

      {tab === 0 && (
        <PlaceOverviewTab
          place={place}
          isLoading={isLoading}
          onNavigateToInfo={() => setTab(2)}
          onOpenDepartures={(mode) => {
            setDeparturesModeFilter(mode ?? null);
            setShowDepartures(true);
          }}
          onOpenLineDetail={(route) => {
            setDeparturesModeFilter(null);
            setSelectedRoute(route);
          }}
          onOpenTripDetail={(dep) => setActiveTripDep(dep)}
        />
      )}
      {tab === 1 && <PlaceReviewsTab place={place} />}
      {tab === 2 && <PlaceInfoTab place={place} isLoading={isLoading} />}
    </>
  );
}
