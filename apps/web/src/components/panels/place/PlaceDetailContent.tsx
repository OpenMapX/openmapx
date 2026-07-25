"use client";

import type { ReviewAggregate } from "@integrations/reviews/types";
import CloseIcon from "@mui/icons-material/Close";
import StarIcon from "@mui/icons-material/Star";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";
import { isCityOrSmaller, isLodging, usePlaceStore } from "@openmapx/core";
import { useReviewAggregate } from "@openmapx/mangrove-react";
import type { MergedRoute, TransportMode } from "@openmapx/mobility-core/transit";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { BRAND } from "@/lib/theme";
import { useDetailChrome } from "../DetailShell";
import { useFloatingMobileSheetHandle } from "../sheet/mobileSheetShared";
import { useMobileSheet, useSheetSentinel } from "../sheet/sheetState";
import { LineDetail } from "../transit/LineDetail";
import { PlaceDeparturesView } from "../transit/PlaceDeparturesView";
import { PlaceTransitSection } from "../transit/PlaceTransitSection";
import { StopBoardView } from "../transit/StopBoardView";
import { StopInfrastructureSection } from "../transit/StopInfrastructureSection";
import { TripDetailView } from "../transit/TripDetailView";
import { PlaceActionButtons } from "./PlaceActionButtons";
import { PlaceHeaderWeather } from "./PlaceHeaderWeather";
import { PlaceHotelPricesTab } from "./PlaceHotelPricesTab";
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

// Pinned mobile-sheet header shown once the sheet is fully expanded. Only the
// place name and close affordance travel up here — Directions/Save/Share stay
// reachable through the inline chips (or the docked action bar once those
// scroll away), so the pinned bar doesn't need to duplicate them.
function CompactTitleBar({ placeName, onClose }: { placeName: string; onClose?: () => void }) {
  const tc = useTranslations("common");
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 2, py: 1.5 }}>
      <Typography variant="subtitle1" noWrap sx={{ flex: 1, fontWeight: 600 }}>
        {placeName}
      </Typography>
      {onClose && (
        <IconButton onClick={onClose} aria-label={tc("close")} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}

// Docked mobile-sheet footer shown once the inline action row has scrolled
// out of view at full expansion, so Directions/Save/Nearby/Share stay one tap
// away without scrolling back up.
function DockedActionBar({ place }: { place: Place }) {
  return (
    <Box sx={{ display: "flex", gap: 1, overflowX: "auto", pt: 1 }}>
      <PlaceActionButtons place={place} />
    </Box>
  );
}

export function PlaceDetailContent({ place, isLoading, onClose, clearSearchBar = false }: Props) {
  const t = useTranslations("place");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { detent, isExpanded, inSheet } = useMobileSheet();
  const { ref: chipsRef, passed: chipsScrolledAway } = useSheetSentinel();
  const { ref: titleRef, passed: titleScrolledAway } = useSheetSentinel();
  const [tab, setTab] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Hero photos whose <img> failed to load — e.g. an OSM `image=` tag pointing
  // at a host the image-proxy doesn't allow (→ 403). Dropping them lets the
  // hero fall through to the next candidate and ultimately to the no-photo
  // layout, instead of keeping the photo-mode top spacing with an empty hero
  // (which hides the title behind the floating search bar).
  const [failedHeroUrls, setFailedHeroUrls] = useState<Set<string>>(new Set());
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
    setFailedHeroUrls(new Set());
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
  //
  // Exception: when the resolved entity is itself a substantial place that
  // *also* doubles as a transit stop (e.g. an airport that's reachable by
  // bus, where the autocomplete originally came from Entur), we want the
  // full place panel so airport / Wikipedia / OSM-tag sections all render.
  // The transit section still shows up as part of the overview tab.
  const isAirportEntity = place.airport !== undefined || place.osmTags?.aeroway === "aerodrome";
  const isStopMode = place.rawCategory === "transit_stop" && !isAirportEntity;
  // The pinned header / docked footer only apply to the default place view —
  // the transit sub-views and stop mode render their own minimal headers and
  // have no action row to dock.
  const isMainView =
    !activeTripDep && !selectedRoute && !activeStopBoard && !showDepartures && !isStopMode;
  // Memoized so setHeader/setFooter (registered by useDetailChrome below) only
  // re-fire when something the chrome actually renders has changed, instead of
  // on every render of this component (tab switches, query refetches, ...) —
  // a fresh JSX element identity each time would otherwise re-trigger those
  // effects and their DetailShell state updates for no visible change.
  // Only once the real title has scrolled out of view. Keying this on
  // expansion alone would repeat the name in a band above the still-visible
  // title, and that band would push the photo hero down from the sheet's top
  // edge.
  const pinnedTitleShown = isMainView && isExpanded && titleScrolledAway;
  const headerNode = useMemo(
    () => (pinnedTitleShown ? <CompactTitleBar placeName={place.name} onClose={onClose} /> : null),
    [pinnedTitleShown, place.name, onClose],
  );
  // The inline row stays mounted when it scrolls out of the scrollport, so
  // while the docked copy is up there are two of every action in the tree.
  // One flag drives both, so they cannot disagree about which copy is live.
  const dockedActionsShown = isMainView && isExpanded && chipsScrolledAway;
  const footerNode = useMemo(
    () => (dockedActionsShown ? <DockedActionBar place={place} /> : null),
    [dockedActionsShown, place],
  );
  useDetailChrome(headerNode, footerNode);
  const [lng, lat] = place.coordinates;
  const headerAggregateQuery = useReviewAggregate<ReviewAggregate>(lat, lng, place.name, {
    osmId: place.ids?.osm,
    enabled: !isStopMode,
  });
  const headerReviewStats =
    headerAggregateQuery.data !== undefined
      ? headerAggregateQuery.data.count > 0
        ? { rating: headerAggregateQuery.data.stars, count: headerAggregateQuery.data.count }
        : null
      : place.rating
        ? { rating: place.rating, count: place.reviewCount ?? 0 }
        : null;
  const placePhotos = place.photos ?? [];
  // Skip photos that already failed to load so the hero advances through any
  // remaining candidates and, when none load, falls back to the no-photo layout.
  const viableHeroPhotos = placePhotos.filter((p) => !failedHeroUrls.has(p.url));
  const hasPhoto =
    !isStopMode &&
    viableHeroPhotos.length > 0 &&
    (viableHeroPhotos[0].url.startsWith("https://") ||
      viableHeroPhotos[0].url.startsWith("http://"));
  // The hero is suppressed at peek (below) so the collapsed sheet shows the
  // marked [data-omx-peek] subtree — title + chips — instead of a cropped
  // slice of a 220px-tall photo sitting above it and uncounted toward the
  // collapsed height. Everything that depends on whether the hero is
  // actually on screen (the floating drag handle, the peek box's own close
  // button, its top padding) keys off this rather than `hasPhoto` alone.
  const showHero = hasPhoto && detent !== "peek";
  // When a photo hero is the first child, let the mobile sheet's drag pill
  // float over it so the image reaches the rounded sheet corners. Not once the
  // sheet is fully expanded: the pinned title bar then occupies that same band,
  // and floating it would paint the place name across the photo. No-op on
  // desktop and when no photo is showing. Must be called before any conditional
  // return — hooks rules.
  useFloatingMobileSheetHandle(showHero && !pinnedTitleShown);

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
          <Typography
            variant="h6"
            sx={{
              fontWeight: 600,
              flex: 1,
              minWidth: 0,
              pr: 1,
            }}
          >
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

  const showPrices = isLodging(place);
  // City (or smaller) admin areas get a compact weather + local-time readout in
  // the header.
  const showHeaderWeather = isCityOrSmaller(place);
  // Tab indices: Overview=0, Reviews=1, [Prices=2 if hotel], Info=last.
  const pricesIndex = showPrices ? 2 : -1;
  const infoIndex = showPrices ? 3 : 2;

  return (
    <>
      {/* Header photo with "View photos" — hidden at peek so the collapsed
          sheet shows the marked [data-omx-peek] subtree (title + chips)
          instead of a cropped slice of the photo. The photo sits ABOVE that
          subtree, so anything rendered here at peek would occupy the visible
          collapsed window without being counted in its measured height. */}
      {showHero ? (
        <PlacePhotoHero
          photos={viableHeroPhotos}
          placeName={place.name}
          onClose={onClose}
          onViewPhotos={() => setGalleryOpen(true)}
          onPhotoError={(url) =>
            setFailedHeroUrls((prev) => {
              const next = new Set(prev);
              next.add(url);
              return next;
            })
          }
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
      {/* Name / rating / category / actions — marked data-omx-peek: this is
          exactly what stays visible when the mobile sheet is collapsed to
          peek, so keep it tight. The rating/category rows drop out at peek
          (below) to keep that collapsed height small. */}
      <Box
        data-omx-peek
        sx={{
          px: 2,
          pt: clearSearchBar && !showHero ? { xs: 2, sm: "72px" } : 2,
          // In a sheet the action row is the last thing in here and brings its
          // own padding on both sides; adding more below would leave the icons
          // sitting closer to the title above them than to the tabs below.
          pb: inSheet ? 0 : 1,
          position: "relative",
        }}
      >
        {/* Close button when the hero isn't showing (no photo, or hidden at peek) */}
        {onClose && !showHero && (
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
              // `action.hover` is translucent and would let the photo hero
              // behind show through. Use the opaque theme-aware chip hover.
              "&:hover": { bgcolor: "var(--omx-chip-hover)" },
            }}
          >
            <CloseIcon sx={{ fontSize: 24, color: "text.primary" }} />
          </IconButton>
        )}

        <Box sx={{ display: "flex", alignItems: "flex-start" }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              ref={titleRef}
              variant="h6"
              gutterBottom
              noWrap={detent === "peek"}
              sx={{
                fontWeight: 600,
                pr: onClose && !showHeaderWeather ? 4 : 0,
              }}
            >
              {place.name}
            </Typography>
            {/* data-omx-peek-hidden: these rows are gone at peek, so the sheet
                must not count them when it works out the collapsed height. */}
            {detent !== "peek" && (
              <Box data-omx-peek-hidden data-testid="place-meta-rows">
                {headerReviewStats && (
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 0.75 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        fontWeight: 600,
                      }}
                    >
                      {headerReviewStats.rating.toFixed(1)}
                    </Typography>
                    <StarIcon sx={{ fontSize: 16, color: "#FBBC04" }} />
                    <Typography
                      variant="body2"
                      sx={{
                        color: "text.secondary",
                      }}
                    >
                      ({headerReviewStats.count.toLocaleString(locale)})
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
            )}
          </Box>
          {showHeaderWeather && (
            // Shift down past the absolute close button when the hero isn't
            // showing, so the weather icon never sits under it.
            <Box sx={{ mt: onClose && !showHero ? 4 : 0 }}>
              <PlaceHeaderWeather lat={place.coordinates[1]} lng={place.coordinates[0]} />
            </Box>
          )}
        </Box>

        {/* Inline action row, sheet only. It sits above the tabs here so it
            falls inside the peek-collapsed subtree and stays reachable
            whichever tab is active; useSheetSentinel reports once it has
            scrolled out of view at full expansion, which is when the docked
            footer takes over. Outside a sheet the Overview tab keeps its own
            copy in the original position. */}
        {inSheet && (
          // `inert` while the docked copy is up: it drops this row from the
          // accessibility tree and the tab order, so the same four actions are
          // not announced twice. It stays mounted because the sentinel that
          // decides which copy is live observes it — intersection still works
          // on an inert node. Scrolling back up clears both together.
          // The row's own padding is symmetric, but the labels sit in a caption
          // line box whose leading adds empty space under the text and nothing
          // above the icons — so equal padding reads as bottom-heavy. Nudge the
          // box gaps apart to bring the visible gaps level.
          <Box ref={chipsRef} inert={dockedActionsShown} sx={{ pt: 0.5, mb: -0.25 }}>
            <PlaceActionButtons place={place} />
          </Box>
        )}
      </Box>
      {/* Tabs */}
      <Tabs
        value={tab}
        onChange={(_, v: number) => setTab(v)}
        sx={(theme) => ({
          position: "sticky",
          top: 0,
          // Light mode: tabs flush with the panel body (#fff on #fff) —
          // separation is handled by the bottom border below.
          // Dark mode: both the SidebarShell rail AND the floating
          // DetailShell card now share background.default (#1c1c1c), so
          // drop the tab strip to the same surface for both contexts.
          bgcolor: "background.paper",
          ...theme.applyStyles("dark", { bgcolor: "background.default" }),
          zIndex: 1,
          minHeight: 48,
          "& .MuiTabs-list": { justifyContent: "space-evenly" },
          "& .MuiTab-root": {
            textTransform: "none",
            fontSize: 14,
            fontWeight: 500,
            minHeight: 48,
            minWidth: "auto",
            color: "text.secondary",
          },
          "& .Mui-selected": { color: `${BRAND} !important` },
          "& .MuiTabs-indicator": {
            height: 3,
            display: "flex",
            justifyContent: "center",
            backgroundColor: "transparent",
            "&::after": {
              content: '""',
              display: "block",
              width: "calc(100% - 32px)",
              backgroundColor: BRAND,
              borderRadius: "2px 2px 0 0",
            },
          },
          borderBottom: "1px solid var(--omx-border-light)",
        })}
      >
        <Tab label={t("overview")} />
        <Tab label={t("reviews")} />
        {showPrices && <Tab label={t("prices")} />}
        <Tab label={t("info")} />
      </Tabs>
      {tab === 0 && (
        <PlaceOverviewTab
          place={place}
          isLoading={isLoading}
          onNavigateToInfo={() => setTab(infoIndex)}
          onOpenPrices={showPrices ? () => setTab(pricesIndex) : undefined}
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
      {showPrices && tab === pricesIndex && <PlaceHotelPricesTab place={place} />}
      {tab === infoIndex && <PlaceInfoTab place={place} isLoading={isLoading} />}
    </>
  );
}
