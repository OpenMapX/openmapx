"use client";

import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  type AlongRoutePoi,
  type BrandSummary,
  CATEGORY_DEFINITIONS,
  type CategoryId,
  type CategoryPlace,
  geoJsonBBox,
  useBrandSuggest,
  useDebounce,
  useNavigationStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { BrandLogo } from "@/components/search/BrandLogo";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { useRouteSearchStore } from "@/lib/navigation/routeSearchStore";
import { routeSearchQueryFor, useRouteSearch } from "@/lib/navigation/useRouteSearch";
import { RouteSearchResultsLayer } from "./RouteSearchResultsLayer";

// MUI LocalGasStation glyph — fuel isn't a poi-search chip category, so we carry
// its icon here and query it via the `preset:amenity/fuel` server path.
const FUEL_ICON_PATH =
  "M19.77 7.23l.01-.01-3.72-3.72L15 4.56l2.11 2.11c-.94.36-1.61 1.26-1.61 2.33 0 1.38 1.12 2.5 2.5 2.5.36 0 .69-.08 1-.21v7.21c0 .55-.45 1-1 1s-1-.45-1-1V14c0-1.1-.9-2-2-2h-1V5c0-1.1-.9-2-2-2H6c-1.1 0-2 .9-2 2v16h9v-7.5h1.5v5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V9c0-.69-.28-1.32-.73-1.77M12 10H6V5h6z";

// MUI Place glyph — the along-route pin icon for a brand search, which (unlike
// a category) has no single glyph of its own.
const PLACE_ICON_PATH =
  "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7m0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5";

function iconFor(id: CategoryId): string {
  return CATEGORY_DEFINITIONS.find((d) => d.id === id)?.iconPath ?? "";
}

interface SearchCategory {
  key: string; // CategoryId or `preset:<id>`
  labelKey: string;
  iconPath: string;
}

const CATEGORIES: SearchCategory[] = [
  { key: "preset:amenity/fuel", labelKey: "rsFuel", iconPath: FUEL_ICON_PATH },
  { key: "restaurants", labelKey: "rsRestaurants", iconPath: iconFor("restaurants") },
  { key: "cafes", labelKey: "rsCafes", iconPath: iconFor("cafes") },
  { key: "supermarkets", labelKey: "rsSupermarkets", iconPath: iconFor("supermarkets") },
  { key: "parking", labelKey: "rsParking", iconPath: iconFor("parking") },
  { key: "hotels", labelKey: "rsHotels", iconPath: iconFor("hotels") },
];

function Glyph({ path, size = 24 }: { path: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={path} />
    </svg>
  );
}

/**
 * "Search along route" picker sheet, result pins and POI card. The entry button
 * lives in the map control stack (see {@link MapControls}); this component reacts
 * to {@link useRouteSearchStore}. Choosing a category, or a specific chain from
 * the brand suggestions below the category grid, drops POI pins along the
 * route ahead (each with an estimated detour); tapping one offers to add it as
 * a stop, which re-plans the trip. Reuses the Explore category search
 * (`useCategorySearch`) and, for a brand, the same filter search the Explore
 * panel uses — both via {@link useRouteSearch}.
 */
export function RouteSearchControl() {
  const t = useTranslations("navigation");
  const mapCtx = useMapOptional();
  const open = useRouteSearchStore((s) => s.open);
  const categoryKey = useRouteSearchStore((s) => s.categoryKey);
  const brand = useRouteSearchStore((s) => s.brand);
  const closePicker = useRouteSearchStore((s) => s.closePicker);
  const setCategoryKey = useRouteSearchStore((s) => s.setCategoryKey);
  const setBrand = useRouteSearchStore((s) => s.setBrand);
  const resetStore = useRouteSearchStore((s) => s.reset);
  const setCameraMode = useNavigationStore((s) => s.setCameraMode);
  const [selected, setSelected] = useState<AlongRoutePoi<CategoryPlace> | null>(null);
  const [adding, setAdding] = useState(false);
  const [brandQuery, setBrandQuery] = useState("");
  const debouncedBrandQuery = useDebounce(brandQuery, 200);
  const { data: brandSuggestData } = useBrandSuggest(debouncedBrandQuery);
  const brandMatches = brandSuggestData?.matches ?? [];

  const category = CATEGORIES.find((c) => c.key === categoryKey) ?? null;
  // A stable identity for whichever selection is active, used to gate the
  // result layer and the center/clear/card chrome below; `brand:<qid>` keeps
  // the pin-image cache in RouteSearchResultsLayer keyed per chain.
  const activeKey = category?.key ?? (brand ? `brand:${brand.qid}` : null);
  const activeIconPath = category?.iconPath ?? PLACE_ICON_PATH;
  const query = category
    ? routeSearchQueryFor({ category: category.key })
    : brand
      ? routeSearchQueryFor({ brand })
      : null;
  const { results, isLoading, addStop } = useRouteSearch(query);

  const handleSelectBrand = (b: BrandSummary) => {
    setBrand(b);
    setBrandQuery("");
  };

  /** Frame the POIs (plus the current position) in the current top-down view. */
  const fitToResults = () => {
    const coords = results.map((r) => r.place.coordinates);
    const snapped = useNavigationStore.getState().progress?.snapped;
    if (snapped) coords.push(snapped);
    if (coords.length === 0) return;
    const box = geoJsonBBox({ type: "MultiPoint", coordinates: coords } as GeoJSON.MultiPoint);
    if (box) {
      // North-up and level again, not "wherever the reset ease has reached":
      // cached results can arrive while it is still running, and this framing
      // stops it where it stands — so the view it was heading for has to be
      // asked for here too.
      mapCtx?.fitBounds(
        [
          [box[0], box[1]],
          [box[2], box[3]],
        ],
        80,
        { bearing: 0, pitch: 0 },
      );
    }
  };

  // While searching, leave the 3D follow camera for a north-up, top-down
  // overview so the spread of POIs along the route is visible; restore follow
  // (which re-tilts and resumes tracking) when the search is cleared.
  const searching = activeKey !== null;
  const fittedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: run on enter/exit of search only.
  useEffect(() => {
    if (!searching) return;
    fittedRef.current = false;
    setCameraMode("overview");
    mapCtx?.resetBearing(); // ease bearing + pitch to 0 (north-up, top-down)
    return () => setCameraMode("follow");
  }, [searching]);

  // Frame the results once they arrive for this search (not on every position
  // update, which would keep yanking the camera while the user pans).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit once per search session.
  useEffect(() => {
    if (searching && !fittedRef.current && results.length > 0) {
      fittedRef.current = true;
      fitToResults();
    }
  }, [searching, results]);

  const reset = () => {
    resetStore();
    setSelected(null);
    setBrandQuery("");
  };

  const handleSelect = (poi: AlongRoutePoi<CategoryPlace>) => {
    setSelected(poi);
    mapCtx?.flyTo(poi.place.coordinates, 15);
  };

  const handleCenter = () => {
    fitToResults();
  };

  const handleAdd = async () => {
    if (!selected) return;
    setAdding(true);
    const ok = await addStop(selected.place.coordinates);
    setAdding(false);
    if (ok) reset();
  };

  return (
    <>
      {/* Result pins stay rendered whenever a category or brand is active. */}
      {activeKey && (
        <RouteSearchResultsLayer
          results={results}
          iconPath={activeIconPath}
          categoryKey={activeKey}
          onSelect={handleSelect}
        />
      )}

      {/* Category picker sheet at the top (over the maneuver banner while open);
          the POI card and center/clear controls stay at the bottom. */}
      {open && (
        <Paper
          elevation={8}
          sx={{
            pointerEvents: "auto",
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            top: "calc(var(--omx-safe-top) + 8px)",
            width: { xs: "calc(100% - 16px)", sm: 480 },
            borderRadius: 3,
            zIndex: 1350,
            p: 2,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
            <IconButton
              size="small"
              onClick={() => {
                closePicker();
                setBrandQuery("");
              }}
              aria-label={t("rsCancel")}
            >
              <ArrowBackIcon fontSize="small" />
            </IconButton>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              {t("searchAlongRoute")}
            </Typography>
          </Box>
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1 }}>
            {CATEGORIES.map((c) => (
              <Box
                key={c.key}
                component="button"
                type="button"
                onClick={() => setCategoryKey(c.key)}
                sx={{
                  cursor: "pointer",
                  border: "1px solid",
                  borderColor: "divider",
                  bgcolor: "background.paper",
                  borderRadius: 2,
                  py: 1.5,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 0.5,
                  color: BRAND,
                  "&:hover": { bgcolor: "action.hover" },
                }}
              >
                <Glyph path={c.iconPath} />
                <Typography variant="caption" sx={{ fontWeight: 600, color: "text.primary" }}>
                  {t(c.labelKey)}
                </Typography>
              </Box>
            ))}
          </Box>

          <Divider sx={{ my: 1.5 }} />
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
            {t("rsBrandLabel")}
          </Typography>
          <TextField
            size="small"
            fullWidth
            placeholder={t("rsBrandPlaceholder")}
            value={brandQuery}
            onChange={(e) => setBrandQuery(e.target.value)}
          />
          {brandMatches.length > 0 && (
            <List dense sx={{ mt: 0.5, maxHeight: 240, overflowY: "auto" }}>
              {brandMatches.map((b) => (
                <ListItemButton
                  key={b.qid}
                  onClick={() => handleSelectBrand(b)}
                  sx={{ borderRadius: 1 }}
                >
                  <ListItemIcon sx={{ minWidth: 32 }}>
                    <BrandLogo brand={b} size={20} />
                  </ListItemIcon>
                  <ListItemText primary={b.name} secondary={b.description} />
                </ListItemButton>
              ))}
            </List>
          )}
        </Paper>
      )}

      {/* Center / Clear controls while showing results (no POI selected). */}
      {activeKey && !open && !selected && (
        <Box
          sx={{
            pointerEvents: "auto",
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(var(--omx-safe-bottom) + 180px)",
            display: "flex",
            gap: 1,
            zIndex: 1350,
          }}
        >
          <Button
            variant="contained"
            color="inherit"
            startIcon={isLoading ? <CircularProgress size={16} /> : <MyLocationIcon />}
            onClick={handleCenter}
            sx={{ bgcolor: "background.paper", borderRadius: 99, color: BRAND }}
          >
            {t("rsCenter")}
          </Button>
          <Button
            variant="contained"
            color="inherit"
            startIcon={<CloseIcon />}
            onClick={reset}
            sx={{ bgcolor: "background.paper", borderRadius: 99, color: "text.primary" }}
          >
            {t("rsClear")}
          </Button>
        </Box>
      )}

      {/* Selected POI card. */}
      {activeKey && !open && selected && (
        <Paper
          elevation={8}
          sx={{
            pointerEvents: "auto",
            position: "fixed",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: "calc(var(--omx-safe-bottom) + 8px)",
            width: { xs: "calc(100% - 16px)", sm: 420 },
            borderRadius: 3,
            zIndex: 1350,
            p: 2,
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, mb: 1.5 }}>
            <Box
              sx={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                bgcolor: brand ? "background.paper" : BRAND,
                border: brand ? "1px solid" : "none",
                borderColor: "divider",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {brand ? (
                <BrandLogo brand={brand} size={28} />
              ) : (
                <Glyph path={activeIconPath} size={22} />
              )}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }} noWrap>
                {selected.place.name}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("rsDetour", { minutes: Math.max(1, Math.round(selected.detourSeconds / 60)) })}
              </Typography>
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 1, justifyContent: "flex-end" }}>
            <Button onClick={() => setSelected(null)} color="inherit">
              {t("rsCancel")}
            </Button>
            <Button
              variant="contained"
              startIcon={
                adding ? <CircularProgress size={16} color="inherit" /> : <AddLocationAltIcon />
              }
              disabled={adding}
              onClick={handleAdd}
            >
              {t("rsAdd")}
            </Button>
          </Box>
        </Paper>
      )}
    </>
  );
}
