"use client";

import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import PhotoOutlinedIcon from "@mui/icons-material/PhotoOutlined";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type {
  CategoryCardEnrichmentResponse,
  CategoryPlace,
  DistanceReference,
  TagPredicate,
} from "@openmapx/core";
import {
  AD_HOC_CATEGORY_ID,
  categoryPlaceToPlace,
  formatMeasurementDistance,
  isAreaTooLarge,
  makeSyntheticStopPlace,
  PANEL,
  proxyImageUrl,
  resolveStopAsPlace,
  resultDistanceMetres,
  sortResultsByIntent,
  useBrandLogos,
  useCategoryFacetStore,
  useCategorySearchStore,
  useOpeningHoursStore,
  usePlaceStore,
  useSettingsStore,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type * as maplibregl from "maplibre-gl";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { distinctBrandQids, placeBrandIdentity } from "@/components/map/CategoryResultMarkers";
import { PhotoAttribution } from "@/components/panels/place/PhotoAttribution";
import { useExpandOnBackgroundTap } from "@/components/panels/sheet/sheetState";
import { BrandLogo } from "@/components/search/BrandLogo";
import { ResultItemName, ResultList, ResultListItem } from "@/components/ui/ResultListItem";
import { ResultNotice } from "@/components/ui/ResultNotice";
import { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import { useMap } from "@/integration-api/map/MapContext";
import { useAttributionFromHooks } from "@/integration-api/overlay/useAttributionFromHooks";
import { attributionsForSources } from "@/lib/attributionForProviders";
import { openingHoursTone } from "@/lib/openingHoursTone";
import { useExploreReachResults } from "@/lib/useExploreReachResults";
import { useOpeningHoursText } from "@/lib/useOpeningHoursText";
import { BrandHeaderCard } from "./BrandHeaderCard";
import { CategoryResultsHeader } from "./CategoryResultsHeader";
import { selectResultAttributes } from "./resultAttributes";
import { cachedSummary, useCardEnrichment } from "./useCardEnrichment";

type CardSummary = CategoryCardEnrichmentResponse["results"][number];
const SLOW_SEARCH_NOTICE_MS = 8_000;

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, typeof TrainIcon>> = {
  rail: TrainIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
};

function SearchLoading({ waitingForResponse }: { waitingForResponse: boolean }) {
  const ts = useTranslations("search");
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!waitingForResponse) return;
    const timer = window.setTimeout(() => setSlow(true), SLOW_SEARCH_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [waitingForResponse]);

  return (
    <Box sx={{ px: 2, py: 2 }}>
      {slow ? (
        <ResultNotice tone="info" pending>
          {ts("searchTakingLonger")}
        </ResultNotice>
      ) : (
        [0, 1, 2, 3, 4].map((i) => (
          <Box key={i} sx={{ mb: 2 }}>
            <Skeleton variant="text" width="60%" height={20} />
            <Skeleton variant="text" width="80%" height={16} />
          </Box>
        ))
      )}
    </Box>
  );
}

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
  summary,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
  brandLogos,
  distanceReference,
}: {
  place: CategoryPlace;
  summary?: CardSummary;
  isHovered: boolean;
  onSelect: (place: CategoryPlace) => void;
  onHover: (id: string) => void;
  onHoverEnd: () => void;
  /** QID -> Commons logo filename, resolved once for the whole result list. */
  brandLogos: Map<string, string | undefined>;
  distanceReference: DistanceReference | null;
}) {
  const tp = useTranslations("place");
  const locale = useLocale();
  const registry = useIntegrationRegistry();
  const tc = useTranslations("common");
  const tcat = useTranslations("category");
  const units = useSettingsStore((s) => s.units);
  const ohText = useOpeningHoursText();
  const th = useTranslations("openingHours");
  const distanceMetres = resultDistanceMetres(distanceReference, place.coordinates);
  const attributes = selectResultAttributes(place.osmTags);
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;
  const brandIdentity = placeBrandIdentity(place);
  const photo = summary?.photo;
  const photoUrl = photo?.thumbnailUrl ?? photo?.url;
  const [failedPhotoUrl, setFailedPhotoUrl] = useState<string | null>(null);
  const showPhoto = Boolean(photoUrl && failedPhotoUrl !== photoUrl);
  const rating = summary?.rating;

  return (
    <>
      <ResultListItem
        onClick={() => onSelect(place)}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") onHover(place.id);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") onHoverEnd();
        }}
        selected={isHovered}
        hoverBg="rgba(0,0,0,0.06)"
      >
        <Box sx={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 72px", gap: 1.5 }}>
          <Box sx={{ minWidth: 0 }}>
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
            <Box
              sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}
            >
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
                    overflowWrap: "anywhere",
                  }}
                >
                  {place.address}
                </Typography>
              )}
            </Box>
            {rating && (
              <Typography
                variant="caption"
                sx={{ color: "text.secondary", display: "block", mb: 0.25 }}
              >
                ★ {new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rating.stars)}{" "}
                · {rating.count} {tp("ratedReviews")} ·{" "}
                {registry.findDataSource(rating.source)?.name ?? rating.source}
              </Typography>
            )}
            {(distanceMetres !== null || attributes.length > 0) && (
              <Box
                sx={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 0.75,
                  alignItems: "center",
                  minWidth: 0,
                  mb: 0.25,
                }}
              >
                {distanceMetres !== null && (
                  <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
                    {formatMeasurementDistance(distanceMetres, units)}
                  </Typography>
                )}
                {attributes.map((attribute) => (
                  <Typography
                    key={attribute.kind}
                    variant="caption"
                    sx={{ color: "text.secondary", overflowWrap: "anywhere" }}
                  >
                    {attribute.kind === "cuisine"
                      ? `${tcat("cuisine")}: ${attribute.value}`
                      : attribute.kind === "outdoor_seating"
                        ? tp("outdoorSeating")
                        : attribute.kind === "wheelchair_yes"
                          ? tp("wheelchairYes")
                          : attribute.kind === "wheelchair_designated"
                            ? tp("wheelchairDesignated")
                            : tp("wheelchairLimited")}
                  </Typography>
                ))}
              </Box>
            )}
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
                      {ohText.state(hours)}
                    </Typography>
                  );
                }
                const detail = ohText.detail(hours);
                return (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    <Box component="span" sx={{ color: openingHoursTone(hours), fontWeight: 700 }}>
                      {ohText.state(hours)}
                    </Box>
                    {detail && <> · {detail}</>}
                  </Typography>
                );
              }
              if (place.isOpen !== undefined) {
                return (
                  <Typography
                    variant="body2"
                    sx={{ color: place.isOpen ? "success.main" : "error.main", fontWeight: 700 }}
                  >
                    {place.isOpen ? tc("open") : tc("closed")}
                  </Typography>
                );
              }
              return (
                <Typography variant="caption" sx={{ color: "text.secondary" }}>
                  {th("unavailable")}
                </Typography>
              );
            })()}
          </Box>
          <Box
            data-testid="result-photo-slot"
            aria-hidden="true"
            sx={{
              width: 72,
              height: 72,
              borderRadius: 1,
              overflow: "hidden",
              bgcolor: "action.hover",
              color: "text.disabled",
              display: "grid",
              placeItems: "center",
            }}
          >
            {showPhoto && photoUrl ? (
              <Box
                component="img"
                src={proxyImageUrl(photoUrl)}
                alt=""
                loading="lazy"
                onError={() => setFailedPhotoUrl(photoUrl)}
                sx={{ width: 72, height: 72, objectFit: "cover" }}
              />
            ) : (
              <PhotoOutlinedIcon />
            )}
          </Box>
        </Box>
      </ResultListItem>
      {showPhoto && photo && (
        <Box sx={{ px: 2, pb: 0.75, color: "text.secondary", fontSize: "0.65rem" }}>
          <PhotoAttribution photo={photo} color="currentColor" />
        </Box>
      )}
    </>
  );
}

export function CategoryResultsContent() {
  const locale = useLocale();
  const ts = useTranslations("search");
  const tc = useTranslations("common");
  const tm = useTranslations("map");
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);
  const setSearchBbox = useCategorySearchStore((s) => s.setSearchBbox);
  const setMapMoved = useCategorySearchStore((s) => s.setMapMoved);
  const hoveredCategoryPlaceId = useCategorySearchStore((s) => s.hoveredCategoryPlaceId);
  const setHoveredCategoryPlaceId = useCategorySearchStore((s) => s.setHoveredCategoryPlaceId);
  const anchor = useCategorySearchStore((s) => s.anchor);
  const adHocLabel = useCategorySearchStore((s) => s.adHocLabel);
  const activeBrand = useCategorySearchStore((s) => s.activeBrand);
  const adHocFilter = useCategorySearchStore((s) => s.adHocFilter);
  const setAdHocFilter = useCategorySearchStore((s) => s.setAdHocFilter);
  const mode = useCategorySearchStore((s) => s.mode);
  const searchRevision = useCategorySearchStore((s) => s.searchRevision);
  const autoRefresh = useCategorySearchStore((s) => s.autoRefresh);
  const setAutoRefresh = useCategorySearchStore((s) => s.setAutoRefresh);
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const facetSelections = useCategoryFacetStore((s) => s.selections);
  const reachActive = useTravelTimeStore(
    (s) => s.isActive && s.anchored && s.origin !== null && s.onlyWithinReach,
  );
  // Viewport text search (top search bar, no anchor) behaves like a category:
  // panning offers "search this area" + the auto-refresh toggle.
  const isViewportText = mode === "text" && anchor === null;
  const { setSelectedPlace } = usePlaceStore();
  const { selectWithEnrichment } = usePlaceEnrichment();
  const { flyTo, mapRef, mapReady, zoomIn, zoomOut } = useMap();
  const expandOnBackgroundTap = useExpandOnBackgroundTap();
  const registry = useIntegrationRegistry();

  const {
    filtered,
    providerFiltered,
    defaultSort,
    isLoading,
    isError,
    error,
    partial,
    truncated,
    total,
    relaxed,
    isTransitCategory,
    refetch,
    distanceReference,
  } = useExploreReachResults();
  const transitStopsQuery = useTransitStops(isTransitCategory ? searchBbox : null);
  const { data: transitStops } = transitStopsQuery;
  const transitAttributions = useAttributionFromHooks(transitStopsQuery);
  const transitLoading = isTransitCategory && transitStopsQuery.isLoading;
  const loading = isTransitCategory ? transitLoading : isLoading;
  const waitingForResponse = isTransitCategory ? transitStopsQuery.isFetching : isLoading;
  const transitAreaTooLarge = isAreaTooLarge(transitStopsQuery.error);
  const hasAdHocPredicates =
    (adHocFilter?.require?.length ?? 0) > 0 || (adHocFilter?.exclude?.length ?? 0) > 0;
  const hasAppliedFilters =
    !isTransitCategory &&
    (openingHoursFilter !== "any" ||
      (activeCategory !== AD_HOC_CATEGORY_ID &&
        Object.values(facetSelections).some((values) => values.length > 0)) ||
      reachActive ||
      hasAdHocPredicates);

  const clearAppliedFilters = () => {
    useOpeningHoursStore.getState().reset();
    useCategoryFacetStore.getState().reset();
    if (reachActive) useTravelTimeStore.getState().setOnlyWithinReach(false);
    if (adHocFilter && hasAdHocPredicates) {
      const { require: _require, exclude: _exclude, ...baseFilter } = adHocFilter;
      setAdHocFilter(baseFilter, "", { preserveSearch: true });
    }
  };

  const prevCategoryRef = useRef<string | null>(null);

  const [sortChoice, setSortChoice] = useState<{
    revision: number;
    value: "relevance" | "distance";
  } | null>(null);
  const chosenSort = sortChoice?.revision === searchRevision ? sortChoice.value : null;
  const results = useMemo(() => {
    if (!chosenSort) return filtered;
    if (chosenSort === "relevance") return providerFiltered ?? filtered;
    return sortResultsByIntent(
      providerFiltered ?? filtered,
      "distance",
      distanceReference?.coordinates ?? null,
    );
  }, [chosenSort, distanceReference, filtered, providerFiltered]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cardSummaries = useCardEnrichment({
    results,
    locale,
    searchRevision,
    activeCategory,
    isTransitCategory,
    scrollRef,
  });
  const poiAttributions = attributionsForSources(
    registry,
    results?.flatMap((place) => [
      ...(place.provenance?.map((source) => source.sourceId) ?? []),
      ...(cachedSummary(cardSummaries, place, locale)?.rating?.source
        ? [cachedSummary(cardSummaries, place, locale)?.rating?.source]
        : []),
    ]) ?? [],
  );
  // Resolved once here (not per row — see useBrandLogos) so hook count stays
  // fixed no matter how many rows carry a brand identity.
  const brandQids = useMemo(() => distinctBrandQids(results ?? []), [results]);
  const brandLogos = useBrandLogos(brandQids);
  const headerCount = isTransitCategory
    ? !transitLoading && !transitStopsQuery.isError && transitStops
      ? transitStops.length
      : null
    : !isLoading && !isError && results
      ? results.length
      : null;

  // Auto-search when category becomes active or changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger on activeCategory change
  useEffect(() => {
    if (!activeCategory || !mapRef.current || !mapReady) return;
    if (activeCategory === prevCategoryRef.current) return;
    prevCategoryRef.current = activeCategory;

    const search = useCategorySearchStore.getState();
    if (
      activeCategory === AD_HOC_CATEGORY_ID &&
      search.searchBbox !== null &&
      search.nlpSearchRevision === search.searchRevision
    ) {
      setMapMoved(false);
      return;
    }

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
    selectWithEnrichment(makeSyntheticStopPlace(s), () => resolveStopAsPlace(s));
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  };

  return (
    // Tapping the collapsed sheet opens it to mid — at peek height only the
    // top of the results list is visible, so any tap should reveal the rest.
    <Box
      ref={scrollRef}
      onClick={expandOnBackgroundTap}
      sx={{ flex: 1, overflowY: "auto", pt: { xs: 0, sm: "64px" } }}
    >
      <BrandHeaderCard />
      {(anchor || activeCategory || isViewportText || headerCount !== null) && (
        <CategoryResultsHeader
          count={headerCount}
          isTransit={isTransitCategory}
          sort={
            chosenSort ??
            (defaultSort === "distance" && distanceReference ? "distance" : "relevance")
          }
          onSort={(value) => setSortChoice({ revision: searchRevision, value })}
          distanceReference={distanceReference ?? null}
          showTravelTime={Boolean(anchor)}
          showMapUpdate={Boolean(activeCategory || isViewportText)}
          autoRefresh={autoRefresh}
          onAutoRefresh={setAutoRefresh}
          adHocLabel={activeCategory === AD_HOC_CATEGORY_ID ? adHocLabel : null}
          attributions={
            headerCount !== null && headerCount > 0
              ? isTransitCategory
                ? transitAttributions
                : poiAttributions
              : null
          }
        />
      )}
      {loading && (
        <SearchLoading
          key={`${mode}:${activeCategory}:${searchRevision}:${JSON.stringify(adHocFilter)}:${waitingForResponse}`}
          waitingForResponse={waitingForResponse}
        />
      )}
      {!isTransitCategory && isError && (
        <Box sx={{ px: 2, py: 2 }}>
          <ResultNotice
            tone={isAreaTooLarge(error) ? "info" : "error"}
            action={{
              label: isAreaTooLarge(error) ? tm("zoomIn") : tc("retry"),
              kind: isAreaTooLarge(error) ? "zoom" : "retry",
              onClick: isAreaTooLarge(error) ? zoomIn : () => void refetch(),
            }}
          >
            {isAreaTooLarge(error) ? ts("zoomInToSearch") : ts("failedToLoad")}
          </ResultNotice>
        </Box>
      )}
      {!isTransitCategory && !isError && partial && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <ResultNotice tone="info">{ts("partialResults")}</ResultNotice>
        </Box>
      )}
      {/* The area holds more matches than the result cap returns. `partial`
          already tells the stronger story (something failed), so only one of the
          two notices ever shows. Both phrasings describe the *area*, never "showing
          N" — the count below is post-filter, so a "showing N" here would contradict
          it whenever an hours or facet chip is active. */}
      {!isTransitCategory && !isError && !partial && truncated && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <ResultNotice tone="info">
            {total === undefined
              ? ts("truncatedResultsUnknown")
              : ts("truncatedResults", { total })}
          </ResultNotice>
        </Box>
      )}
      {!isTransitCategory && !isError && relaxed && relaxed.length > 0 && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <ResultNotice tone="info">
            {ts("relaxedFilters", { filters: relaxed.map(relaxedFilterLabel).join(", ") })}
          </ResultNotice>
        </Box>
      )}
      {/* Transit: empty state */}
      {isTransitCategory && transitStopsQuery.isError && (
        <Box sx={{ px: 2, py: 2 }}>
          <ResultNotice
            tone={transitAreaTooLarge ? "info" : "error"}
            action={{
              label: transitAreaTooLarge ? tm("zoomIn") : tc("retry"),
              kind: transitAreaTooLarge ? "zoom" : "retry",
              onClick: transitAreaTooLarge ? zoomIn : () => void transitStopsQuery.refetch(),
            }}
          >
            {transitAreaTooLarge ? ts("zoomInToSearch") : ts("failedToLoad")}
          </ResultNotice>
        </Box>
      )}
      {isTransitCategory &&
        !transitLoading &&
        !transitStopsQuery.isError &&
        transitStops &&
        transitStops.length === 0 && (
          <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
            <Typography
              sx={{
                color: "text.secondary",
              }}
            >
              {ts("noStopsFound")}
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              {ts("moveMapToSearch")}
            </Typography>
            <Button size="small" variant="outlined" sx={{ mt: 1.5 }} onClick={zoomOut}>
              {tm("zoomOut")}
            </Button>
          </Box>
        )}
      {/* Transit: results list */}
      {isTransitCategory &&
        !transitLoading &&
        !transitStopsQuery.isError &&
        transitStops &&
        transitStops.length > 0 && (
          <ResultList
            items={transitStops}
            getKey={(stop) => stop.id}
            renderItem={(stop) => <TransitStopCard stop={stop} onSelect={handleSelectStop} />}
          />
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
          {!hasAppliedFilters && (
            <Typography variant="body2" sx={{ color: "text.secondary", mt: 1 }}>
              {ts("moveMapToSearch")}
            </Typography>
          )}
          <Button
            size="small"
            variant="outlined"
            sx={{ mt: 1.5 }}
            onClick={hasAppliedFilters ? clearAppliedFilters : zoomOut}
          >
            {hasAppliedFilters ? ts("clearFilters") : tm("zoomOut")}
          </Button>
        </Box>
      )}
      {/* Non-transit: results list */}
      {!isTransitCategory && !isLoading && !isError && results && results.length > 0 && (
        <ResultList
          items={results}
          getKey={(place) => place.id}
          renderItem={(place) => (
            <Box data-card-id={place.id}>
              <CategoryPlaceCard
                place={place}
                summary={cachedSummary(cardSummaries, place, locale)}
                isHovered={hoveredCategoryPlaceId === place.id}
                onSelect={handleSelectPlace}
                onHover={setHoveredCategoryPlaceId}
                onHoverEnd={() => setHoveredCategoryPlaceId(null)}
                brandLogos={brandLogos}
                distanceReference={distanceReference}
              />
            </Box>
          )}
        />
      )}
    </Box>
  );
}
