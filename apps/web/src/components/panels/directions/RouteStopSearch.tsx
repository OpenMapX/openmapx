"use client";

import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import StorefrontIcon from "@mui/icons-material/Storefront";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  type AlongRoutePoi,
  type BrandSummary,
  type CategoryPlace,
  type DirectionsQueryParams,
  formatDistance,
  MAX_DIRECTIONS_WAYPOINTS,
  type Route,
  routeStopInsertIndex,
  useBrandSuggest,
  useDebounce,
  useDirectionsStore,
} from "@openmapx/core";
import {
  contributorsForRecordFields,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { RouteSearchResultsLayer } from "@/components/navigation/RouteSearchResultsLayer";
import {
  PLACE_ICON_PATH,
  ROUTE_SEARCH_CATEGORIES,
  RouteSearchGlyph,
} from "@/components/navigation/routeSearchCategories";
import { useMobileSheet } from "@/components/panels/sheet/sheetState";
import { BrandLogo } from "@/components/search/BrandLogo";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { routeStopCopy } from "@/lib/navigation/routeStopCopy";
import {
  usePlannedRouteSearch,
  usePlannedStopDetour,
} from "@/lib/navigation/usePlannedRouteSearch";
import { routeSearchQueryFor } from "@/lib/navigation/useRouteSearch";

/** Rows shown at first and added by each "Show more". */
const PAGE_SIZE = 20;
const METERS_PER_MILE = 1609.34;

type Units = "metric" | "imperial";

function formatRouteDistance(meters: number, units: Units): string {
  return units === "imperial"
    ? `${(meters / METERS_PER_MILE).toFixed(1)} mi`
    : formatDistance(meters);
}

function formatRoundDistance(meters: number, units: Units, locale: string): string {
  const value = units === "imperial" ? meters / METERS_PER_MILE : meters / 1000;
  return `${new Intl.NumberFormat(locale).format(Math.round(value))} ${units === "imperial" ? "mi" : "km"}`;
}

export interface RouteStopSearchProps {
  /** The selected route the stops are searched along. */
  route: Route;
  /** The provider that answered the displayed route. */
  provider?: string;
  /** The displayed route's request, so detours compare like with like. */
  request: Omit<DirectionsQueryParams, "waypoints">;
  units: Units;
}

/**
 * "Stops along the route" before navigation starts: pick a kind of stop or a
 * chain, browse what lies within the corridor of the selected route (in route
 * order, with pins on the map), compare one result's road detour and add it as
 * a stop. Adding inserts an ordinary waypoint, so the directions panel replans
 * exactly as it does for any edit of the waypoint list.
 */
export function RouteStopSearch({ route, provider, request, units }: RouteStopSearchProps) {
  const t = useTranslations("navigation");
  const td = useTranslations("directions");
  const tc = useTranslations("common");
  const locale = useLocale();
  const mapCtx = useMapOptional();
  const { inSheet, snapTo } = useMobileSheet();
  const waypoints = useDirectionsStore((s) => s.waypoints);
  const activeRouteIndex = useDirectionsStore((s) => s.activeRouteIndex);
  const insertWaypoint = useDirectionsStore((s) => s.insertWaypoint);

  const [categoryKey, setCategoryKey] = useState<string | null>(null);
  const [brand, setBrand] = useState<BrandSummary | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [brandQuery, setBrandQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [addFailed, setAddFailed] = useState(false);
  const [scrollRequest, setScrollRequest] = useState(0);
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  const debouncedBrandQuery = useDebounce(brandQuery, 200);
  const { data: brandSuggestData } = useBrandSuggest(debouncedBrandQuery, undefined, {
    enabled: chainOpen,
  });
  const brandMatches = chainOpen ? (brandSuggestData?.matches ?? []) : [];

  const category = ROUTE_SEARCH_CATEGORIES.find((c) => c.key === categoryKey) ?? null;
  const activeKey = category?.key ?? (brand ? `brand:${brand.qid}` : null);
  const iconPath = category?.iconPath ?? PLACE_ICON_PATH;
  const query = useMemo(
    () =>
      categoryKey
        ? routeSearchQueryFor({ category: categoryKey })
        : brand
          ? routeSearchQueryFor({ brand })
          : null,
    [categoryKey, brand],
  );
  const search = usePlannedRouteSearch(route.geometry, query, locale);

  const waypointCoords = useMemo(
    () => waypoints.flatMap((wp) => (wp.coords ? [wp.coords] : [])),
    [waypoints],
  );
  // A selection belongs to one drawn route; another alternative or a replan
  // retires it, while the chosen kind of stop stays active.
  const routeKey = JSON.stringify([
    waypointCoords,
    activeRouteIndex,
    route.distance,
    route.geometry.length,
  ]);
  useEffect(() => {
    void routeKey;
    setSelectedId(null);
    setVisibleCount(PAGE_SIZE);
    setAddFailed(false);
  }, [routeKey]);

  const selectedBase = search.results.find((r) => r.place.id === selectedId) ?? null;
  const { detour, isPending: detourPending } = usePlannedStopDetour({
    geometry: route.geometry,
    waypoints: waypointCoords,
    candidate: selectedBase?.place ?? null,
    provider,
    request,
  });
  const selected = useMemo<AlongRoutePoi<CategoryPlace> | null>(
    () =>
      selectedBase
        ? {
            ...selectedBase,
            ...(detour ? { detour } : {}),
            ...(detourPending && !detour ? { detourPending: true } : {}),
            ...(detour?.kind === "network"
              ? { detourSeconds: detour.seconds, detourMeters: detour.meters }
              : {}),
          }
        : null,
    [selectedBase, detour, detourPending],
  );
  const pinResults = useMemo(
    () =>
      selected
        ? search.results.map((r) => (r.place.id === selected.place.id ? selected : r))
        : search.results,
    [search.results, selected],
  );

  useEffect(() => {
    if (scrollRequest === 0) return;
    const frame = requestAnimationFrame(() =>
      selectedRowRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [scrollRequest]);

  const clearSelection = () => {
    setSelectedId(null);
    setAddFailed(false);
  };
  const reset = () => {
    setCategoryKey(null);
    setBrand(null);
    setChainOpen(false);
    setBrandQuery("");
    setVisibleCount(PAGE_SIZE);
    clearSelection();
  };

  const chooseCategory = (key: string) => {
    const next = key === categoryKey ? null : key;
    reset();
    setCategoryKey(next);
  };
  const toggleChain = () => {
    if (brand || chainOpen) {
      reset();
      return;
    }
    reset();
    setChainOpen(true);
  };
  const chooseBrand = (b: BrandSummary) => {
    reset();
    setBrand(b);
  };

  const select = (poi: AlongRoutePoi<CategoryPlace>, fromMap: boolean) => {
    setAddFailed(false);
    if (!fromMap && poi.place.id === selectedId) {
      setSelectedId(null);
      return;
    }
    setSelectedId(poi.place.id);
    const index = search.results.findIndex((r) => r.place.id === poi.place.id);
    if (index >= visibleCount) setVisibleCount(Math.ceil((index + 1) / PAGE_SIZE) * PAGE_SIZE);
    if (fromMap) {
      if (inSheet) snapTo("full");
      setScrollRequest((n) => n + 1);
    } else {
      mapCtx?.flyTo(poi.place.coordinates, 14);
    }
  };

  const atLimit = waypoints.length >= MAX_DIRECTIONS_WAYPOINTS;
  const handleAdd = () => {
    if (!selected) return;
    const target = selected.place.routingEntrance ?? selected.place.coordinates;
    const index =
      waypointCoords.length === waypoints.length
        ? routeStopInsertIndex(route.geometry, waypointCoords, target)
        : -1;
    if (index > 0 && insertWaypoint(index, target, selected.place.name)) {
      reset();
      return;
    }
    setAddFailed(true);
  };

  const shown = useMemo(
    () => search.results.slice(0, visibleCount),
    [search.results, visibleCount],
  );
  const listAttributions = useMemo(
    () =>
      snapshotContributors(
        ...shown.map((r) => contributorsForRecordFields(r.place, ["name", "coordinates"])),
      ),
    [shown],
  );

  const renderSelectedCard = (poi: AlongRoutePoi<CategoryPlace>) => {
    const copy = routeStopCopy(poi);
    const entrance = poi.detour?.access.kind === "entrance" || !!poi.place.routingEntrance;
    const credits = snapshotContributors(
      contributorsForRecordFields(poi.place, [
        "name",
        entrance ? "routingEntrance" : "coordinates",
      ]),
      poi.detour?.kind === "network"
        ? contributorsForRecordFields(poi.detour, ["seconds", "meters"])
        : [],
    );
    return (
      <Box
        role="region"
        aria-label={poi.place.name}
        sx={{ px: 2, pb: 1.5, pt: 0.5, bgcolor: "action.hover" }}
      >
        <Typography variant="body2" aria-live="polite">
          {t(copy.key, "values" in copy ? copy.values : undefined)}
        </Typography>
        {poi.detour?.kind === "network" && (
          <Typography variant="body2" color="text.secondary">
            {t("rsPlanDetourDistance", {
              distance: formatRouteDistance(poi.detour.meters, units),
            })}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
          {t(entrance ? "rsDetourEntrance" : "rsDetourCoordinate")}
        </Typography>
        <AttributionStrip attributions={credits} variant="plain" provenanceDisplay="details" />
        {atLimit && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {t("rsPlanStopLimit")}
          </Typography>
        )}
        {addFailed && (
          <Typography role="alert" color="error" variant="body2" sx={{ mt: 1 }}>
            {t("rsAddFailed")}
          </Typography>
        )}
        <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end", mt: 1 }}>
          <Button color="inherit" onClick={clearSelection}>
            {t("rsCancel")}
          </Button>
          <Button
            variant="contained"
            startIcon={<AddLocationAltIcon />}
            disabled={atLimit || poi.detour?.kind === "unreachable"}
            onClick={handleAdd}
          >
            {td("addStop")}
          </Button>
        </Box>
      </Box>
    );
  };

  return (
    <Box component="section" aria-label={t("rsPlanTitle")} sx={{ pt: 1.5, pb: 1 }}>
      <Typography variant="subtitle2" sx={{ px: 2, mb: 1, fontWeight: 600 }}>
        {t("rsPlanTitle")}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, px: 2 }}>
        {ROUTE_SEARCH_CATEGORIES.map((c) => {
          const active = c.key === categoryKey;
          return (
            <Chip
              key={c.key}
              clickable
              aria-pressed={active}
              color={active ? "primary" : "default"}
              variant={active ? "filled" : "outlined"}
              icon={<RouteSearchGlyph path={c.iconPath} size={18} />}
              label={t(c.labelKey)}
              onClick={() => chooseCategory(c.key)}
            />
          );
        })}
        <Chip
          clickable
          aria-pressed={brand !== null || chainOpen}
          color={brand ? "primary" : "default"}
          variant={brand || chainOpen ? "filled" : "outlined"}
          icon={<StorefrontIcon sx={{ fontSize: 18 }} />}
          label={brand ? brand.name : t("rsPlanChain")}
          onClick={toggleChain}
        />
      </Box>

      {chainOpen && (
        <Box sx={{ px: 2, pt: 1.5 }}>
          <TextField
            size="small"
            fullWidth
            autoFocus
            label={t("rsBrandLabel")}
            placeholder={t("rsBrandPlaceholder")}
            value={brandQuery}
            onChange={(e) => setBrandQuery(e.target.value)}
          />
          {brandMatches.length > 0 && (
            <List dense sx={{ mt: 0.5, maxHeight: 240, overflowY: "auto" }}>
              {brandMatches.map((b) => (
                <BrandLogo
                  key={b.qid}
                  brand={b}
                  size={20}
                  render={({ mark, credits }) => (
                    <>
                      <ListItemButton onClick={() => chooseBrand(b)} sx={{ borderRadius: 1 }}>
                        <ListItemIcon sx={{ minWidth: 32 }}>{mark}</ListItemIcon>
                        <ListItemText primary={b.name} secondary={b.description} />
                      </ListItemButton>
                      {credits && (
                        <Box sx={{ px: 2, pb: 1, color: "text.secondary", fontSize: "0.65rem" }}>
                          {credits}
                        </Box>
                      )}
                    </>
                  )}
                />
              ))}
            </List>
          )}
        </Box>
      )}

      {query && (
        <Box sx={{ px: 2, pt: 1.5 }} role="status" aria-live="polite">
          {search.isSearching ? (
            <>
              <Typography variant="body2" color="text.secondary">
                {t("rsPlanSearching")}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={search.totalChunks ? (100 * search.settledChunks) / search.totalChunks : 0}
                sx={{ mt: 0.75, borderRadius: 1 }}
              />
            </>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t("rsPlanCount", { count: search.results.length })}
            </Typography>
          )}
          {search.capped && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {t("rsPlanCapped", {
                distance: formatRoundDistance(search.searchedMeters, units, locale),
              })}
            </Typography>
          )}
          {search.truncated && (
            <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
              {t("rsPlanTruncated")}
            </Typography>
          )}
          {(search.failedChunks > 0 || search.incomplete) && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Typography variant="caption" color="error">
                {t("rsPlanIncomplete")}
              </Typography>
              {search.failedChunks > 0 && (
                <Button size="small" onClick={search.retry}>
                  {tc("retry")}
                </Button>
              )}
            </Box>
          )}
        </Box>
      )}

      {query && shown.length > 0 && (
        <>
          <List dense disablePadding sx={{ mt: 1 }}>
            {shown.map((poi) => {
              const isSelected = poi.place.id === selectedId;
              const row = isSelected && selected ? selected : poi;
              const copy = routeStopCopy(row);
              return (
                <Box key={poi.place.id} ref={isSelected ? selectedRowRef : undefined}>
                  <ListItemButton
                    selected={isSelected}
                    aria-expanded={isSelected}
                    onClick={() => select(poi, false)}
                    sx={{ px: 2 }}
                  >
                    <ListItemIcon sx={{ minWidth: 36, color: BRAND }}>
                      <RouteSearchGlyph path={iconPath} size={22} />
                    </ListItemIcon>
                    <ListItemText
                      primary={poi.place.name}
                      secondary={`${t("rsPlanFromStart", {
                        distance: formatRouteDistance(poi.alongMeters, units),
                      })} · ${t(copy.key, "values" in copy ? copy.values : undefined)}`}
                    />
                  </ListItemButton>
                  {isSelected && selected && renderSelectedCard(selected)}
                </Box>
              );
            })}
          </List>
          {search.results.length > shown.length && (
            <Box sx={{ px: 2 }}>
              <Button size="small" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
                {t("rsPlanShowMore")}
              </Button>
            </Box>
          )}
          <Box sx={{ px: 2, pt: 0.5 }}>
            <AttributionStrip attributions={listAttributions} variant="plain" />
          </Box>
        </>
      )}

      {query && activeKey && mapCtx && (
        <RouteSearchResultsLayer
          results={pinResults}
          iconPath={iconPath}
          categoryKey={activeKey}
          brandQid={brand?.qid}
          onSelect={(poi) => select(poi, true)}
        />
      )}
    </Box>
  );
}
