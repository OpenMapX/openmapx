"use client";

import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Skeleton from "@mui/material/Skeleton";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { CategoryPlace, TagPredicate } from "@openmapx/core";
import {
  AD_HOC_CATEGORY_ID,
  categoryPlaceToPlace,
  isAreaTooLarge,
  PANEL,
  resolveStopAsPlace,
  useBrandLogos,
  useCategorySearchStore,
  usePlaceStore,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type * as maplibregl from "maplibre-gl";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";
import { distinctBrandQids, placeBrandIdentity } from "@/components/map/CategoryResultMarkers";
import { useExpandOnBackgroundTap } from "@/components/panels/sheet/sheetState";
import { BrandLogo } from "@/components/search/BrandLogo";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ResultItemName, ResultList, ResultListItem } from "@/components/ui/ResultListItem";
import { attributionsForSources } from "@/lib/attributionForProviders";
import { useMap } from "@/lib/MapContext";
import { useAttributionFromHooks } from "@/lib/useAttributionFromHooks";
import { useExploreReachResults } from "@/lib/useExploreReachResults";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";
import { BrandHeaderCard } from "./BrandHeaderCard";
import { ExploreTravelTimeControl } from "./ExploreTravelTimeControl";

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, typeof TrainIcon>> = {
  rail: TrainIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
};

// Human-readable label for a dropped `require` predicate, for the relaxation
// notice. Prefers the meaningful term: the value for things like `cuisine~thai`,
// or the (last segment of the) key for affirmative tags like `diet:vegan=yes`.
const AFFIRMATIVE_VALUES = new Set(["yes", "only", "true", "1", "wlan"]);
function relaxedFilterLabel(pred: TagPredicate): string {
  const tail = pred.key.includes(":") ? (pred.key.split(":").pop() ?? pred.key) : pred.key;
  const niceKey = tail.replace(/_/g, " ");
  const value = pred.value;
  if (!value || AFFIRMATIVE_VALUES.has(value)) return niceKey;
  return `${niceKey}: ${value}`;
}

function TransitStopCard({
  stop,
  onSelect,
}: {
  stop: TransitStop;
  onSelect: (stop: TransitStop) => void;
}) {
  return (
    <ResultListItem onClick={() => onSelect(stop)} hoverBg="rgba(0,0,0,0.06)">
      <ResultItemName>{stop.name}</ResultItemName>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        {Array.from(new Set(stop.modes)).map((m) => {
          const Icon = TRANSIT_MODE_ICONS[m] ?? DirectionsBusIcon;
          return <Icon key={m} sx={{ fontSize: 16, color: "text.secondary" }} />;
        })}
      </Box>
    </ResultListItem>
  );
}

function CategoryPlaceCard({
  place,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
  brandLogos,
}: {
  place: CategoryPlace;
  isHovered: boolean;
  onSelect: (place: CategoryPlace) => void;
  onHover: (id: string) => void;
  onHoverEnd: () => void;
  /** QID -> Commons logo filename, resolved once for the whole result list. */
  brandLogos: Map<string, string | undefined>;
}) {
  const tp = useTranslations("place");
  const tc = useTranslations("common");
  const ohText = useOpeningHoursText();
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;
  const brandIdentity = placeBrandIdentity(place);

  return (
    <ResultListItem
      onClick={() => onSelect(place)}
      onMouseEnter={() => onHover(place.id)}
      onMouseLeave={onHoverEnd}
      selected={isHovered}
      hoverBg="rgba(0,0,0,0.06)"
    >
      {brandIdentity ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <BrandLogo
            brand={{
              qid: brandIdentity.qid,
              name: place.brand?.name ?? place.name,
              logoFile: brandLogos.get(brandIdentity.qid),
              kind: [brandIdentity.kind],
            }}
            size={20}
          />
          {/* minWidth: 0 lets the name shrink/wrap inside the row instead of
              pushing the fixed-size logo out or overflowing the list item. */}
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <ResultItemName>{place.name}</ResultItemName>
          </Box>
        </Box>
      ) : (
        <ResultItemName>{place.name}</ResultItemName>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}>
        {tagLabel && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {tagLabel}
          </Typography>
        )}
        {tagLabel && place.address && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            ·
          </Typography>
        )}
        {place.address && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {place.address}
          </Typography>
        )}
      </Box>
      {(() => {
        const hours = place.openingHoursInfo?.status ?? null;
        if (hours) {
          if (hours.isUnknown) {
            return (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {hours.text}
              </Typography>
            );
          }
          const detail = ohText.detail(hours);
          return (
            <Typography variant="caption" color={hours.isOpen ? "success.main" : "error.main"}>
              {hours.isOpen ? tp("openDetail", { detail }) : tp("closedDetail", { detail })}
            </Typography>
          );
        }
        if (place.isOpen !== undefined) {
          return (
            <Typography variant="caption" color={place.isOpen ? "success.main" : "error.main"}>
              {place.isOpen ? tc("open") : tc("closed")}
            </Typography>
          );
        }
        return null;
      })()}
    </ResultListItem>
  );
}

export function CategoryResultsContent() {
  const ts = useTranslations("search");
  const tc = useTranslations("common");
  const {
    activeCategory,
    searchBbox,
    setSearchBbox,
    setMapMoved,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
  } = useCategorySearchStore();
  const anchor = useCategorySearchStore((s) => s.anchor);
  const adHocLabel = useCategorySearchStore((s) => s.adHocLabel);
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const mode = useCategorySearchStore((s) => s.mode);
  const autoRefresh = useCategorySearchStore((s) => s.autoRefresh);
  const setAutoRefresh = useCategorySearchStore((s) => s.setAutoRefresh);
  // Viewport text search (top search bar, no anchor) behaves like a category:
  // panning offers "search this area" + the auto-refresh toggle.
  const isViewportText = mode === "text" && anchor === null;
  const { setSelectedPlace } = usePlaceStore();
  const { flyTo, mapRef, mapReady } = useMap();
  const expandOnBackgroundTap = useExpandOnBackgroundTap();
  const registry = useIntegrationRegistry();

  const {
    filtered,
    isLoading,
    isError,
    error,
    partial,
    truncated,
    total,
    relaxed,
    isTransitCategory,
  } = useExploreReachResults();
  const transitStopsQuery = useTransitStops(isTransitCategory ? searchBbox : null);
  const { data: transitStops, isPending: transitPending } = transitStopsQuery;
  const transitAttributions = useAttributionFromHooks(transitStopsQuery);
  const transitLoading = isTransitCategory && transitPending;

  const prevCategoryRef = useRef<string | null>(null);

  const results = filtered;
  const poiAttributions = attributionsForSources(
    registry,
    results?.flatMap((place) => place.provenance?.map((source) => source.sourceId) ?? []) ?? [],
  );
  // Resolved once here (not per row — see useBrandLogos) so hook count stays
  // fixed no matter how many rows carry a brand identity.
  const brandQids = useMemo(() => distinctBrandQids(results ?? []), [results]);
  const brandLogos = useBrandLogos(brandQids);

  // Auto-search when category becomes active or changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger on activeCategory change
  useEffect(() => {
    if (!activeCategory || !mapRef.current || !mapReady) return;
    if (activeCategory === prevCategoryRef.current) return;
    prevCategoryRef.current = activeCategory;

    const bounds = mapRef.current.getBounds();
    setSearchBbox({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    });
    setMapMoved(false);
  }, [activeCategory, mapReady]);

  // Clear prev category ref when category is cleared
  useEffect(() => {
    if (!activeCategory) {
      prevCategoryRef.current = null;
      setMapMoved(false);
    }
  }, [activeCategory, setMapMoved]);

  // Map movement: auto-refresh the search when enabled, otherwise show the
  // manual "Search this area" chip.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || (!activeCategory && !isViewportText)) return;

    const onMoveEnd = (e: maplibregl.MapLibreEvent) => {
      // Ignore app-driven camera moves (flyTo on result select, fitBounds on
      // launch — tagged with `programmatic`). Only react to real user pan/zoom.
      if ((e as { programmatic?: boolean }).programmatic) return;
      if (autoRefresh) {
        const b = map.getBounds();
        setSearchBbox({
          west: b.getWest(),
          south: b.getSouth(),
          east: b.getEast(),
          north: b.getNorth(),
        });
        setMapMoved(false);
      } else {
        setMapMoved(true);
      }
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapRef, mapReady, activeCategory, isViewportText, autoRefresh, setSearchBbox, setMapMoved]);

  const handleSelectPlace = (place: CategoryPlace) => {
    flyTo(place.coordinates, 17);
    setSelectedPlace(categoryPlaceToPlace(place, activeCategory ?? undefined));
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  };

  const handleSelectStop = (s: TransitStop) => {
    flyTo([s.lng, s.lat], 16);
    void resolveStopAsPlace(s).then((place) => {
      setSelectedPlace(place);
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    });
  };

  return (
    // Tapping the collapsed sheet opens it to mid — at peek height only the
    // top of the results list is visible, so any tap should reveal the rest.
    <Box
      onClick={expandOnBackgroundTap}
      sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" } }}
    >
      <BrandHeaderCard />
      {(anchor || activeCategory || isViewportText) && (
        <Box
          sx={{
            px: 2,
            py: 1,
            borderBottom: "1px solid var(--omx-border)",
            display: "flex",
            flexDirection: "column",
            gap: 0.75,
          }}
        >
          {anchor && <ExploreTravelTimeControl />}
          {(activeCategory || isViewportText) && (
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={autoRefresh}
                  onChange={(e) => setAutoRefresh(e.target.checked)}
                />
              }
              label={<Typography variant="body2">{ts("updateOnMapMove")}</Typography>}
            />
          )}
        </Box>
      )}
      {(isTransitCategory ? transitLoading : isLoading) && (
        <Box sx={{ px: 2, py: 2 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Box key={i} sx={{ mb: 2 }}>
              <Skeleton variant="text" width="60%" height={20} />
              <Skeleton variant="text" width="80%" height={16} />
            </Box>
          ))}
        </Box>
      )}
      {!isTransitCategory && isError && (
        <Box sx={{ px: 2, py: 2 }}>
          <Alert severity={isAreaTooLarge(error) ? "info" : "error"} variant="outlined">
            {isAreaTooLarge(error) ? ts("zoomInToSearch") : ts("failedToLoad")}
          </Alert>
        </Box>
      )}
      {!isTransitCategory && !isError && partial && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Alert severity="info" variant="outlined">
            {ts("partialResults")}
          </Alert>
        </Box>
      )}
      {/* The area holds more matches than the result cap returns. `partial`
          already tells the stronger story (something failed), so only one of the
          two notices ever shows. Both phrasings describe the *area*, never "showing
          N" — the count below is post-filter, so a "showing N" here would contradict
          it whenever an hours or facet chip is active. */}
      {!isTransitCategory && !isError && !partial && truncated && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Alert severity="info" variant="outlined">
            {total === undefined
              ? ts("truncatedResultsUnknown")
              : ts("truncatedResults", { total })}
          </Alert>
        </Box>
      )}
      {!isTransitCategory && !isError && relaxed && relaxed.length > 0 && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <Alert severity="info" variant="outlined">
            {ts("relaxedFilters", { filters: relaxed.map(relaxedFilterLabel).join(", ") })}
          </Alert>
        </Box>
      )}
      {/* Transit: empty state */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length === 0 && (
        <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
          <Typography
            sx={{
              color: "text.secondary",
            }}
          >
            {ts("noStopsFound")}
          </Typography>
        </Box>
      )}
      {/* Transit: results list */}
      {isTransitCategory && !transitLoading && transitStops && transitStops.length > 0 && (
        <>
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
              }}
            >
              {tc("stopsCount", { count: transitStops.length })}
            </Typography>
          </Box>
          <AttributionStrip
            attributions={transitAttributions}
            variant="inline"
            label={tc("dataSources")}
          />
          <ResultList
            items={transitStops}
            getKey={(stop) => stop.id}
            renderItem={(stop) => <TransitStopCard stop={stop} onSelect={handleSelectStop} />}
          />
        </>
      )}
      {/* Non-transit: empty state */}
      {!isTransitCategory && !isLoading && !isError && results && results.length === 0 && (
        <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
          <Typography
            sx={{
              color: "text.secondary",
            }}
          >
            {activeBrand
              ? ts("noBrandLocationsInView", { brand: activeBrand.name })
              : ts("noResultsFound")}
          </Typography>
        </Box>
      )}
      {/* Non-transit: results list */}
      {!isTransitCategory && !isLoading && results && results.length > 0 && (
        <>
          {activeCategory === AD_HOC_CATEGORY_ID && (adHocLabel ?? null) !== null && (
            <Box sx={{ px: 2, pt: 1.5, pb: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                {adHocLabel}
              </Typography>
            </Box>
          )}
          <Box sx={{ px: 2, pt: 1.5, pb: 0.5, display: "flex", alignItems: "center", gap: 1 }}>
            <Typography
              variant="body2"
              sx={{
                color: "text.secondary",
                flex: 1,
              }}
            >
              {tc("resultsCount", { count: results.length })}
            </Typography>
          </Box>
          <Box sx={{ px: 2 }}>
            <AttributionStrip
              attributions={poiAttributions}
              variant="inline"
              label={tc("dataSources")}
              maxVisible={3}
            />
          </Box>
          <ResultList
            items={results}
            getKey={(place) => place.id}
            renderItem={(place) => (
              <CategoryPlaceCard
                place={place}
                isHovered={hoveredCategoryPlaceId === place.id}
                onSelect={handleSelectPlace}
                onHover={setHoveredCategoryPlaceId}
                onHoverEnd={() => setHoveredCategoryPlaceId(null)}
                brandLogos={brandLogos}
              />
            )}
          />
        </>
      )}
    </Box>
  );
}
