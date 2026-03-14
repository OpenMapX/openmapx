"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import SortIcon from "@mui/icons-material/Sort";
import TrainIcon from "@mui/icons-material/Train";
import TramIcon from "@mui/icons-material/Tram";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { CategoryPlace, FuelPrices, TransitStop, TransportMode } from "@openmapx/core";
import {
  categoryPlaceToPlace,
  parseOpeningHours,
  resolveProvider,
  useCategorySearchStore,
  useFilteredCategoryResults,
  usePlaceStore,
  useProviders,
  useTransitStops,
} from "@openmapx/core";
import { useEffect, useRef, useState } from "react";
import { FuelPrice } from "@/components/ui/FuelPrice";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { resolveStopAsPlace } from "@/lib/geocodeStopAsPlace";
import { PANEL_WIDTH } from "@/lib/layout";
import { useMap } from "@/lib/MapContext";

type SortField = "default" | "price";
type SortDir = "asc" | "desc";

const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "price", label: "Price" },
];

const DIR_LABELS: Record<SortDir, string> = {
  asc: "Low to high",
  desc: "High to low",
};

function applyCategorySort(
  results: CategoryPlace[],
  field: SortField,
  dir: SortDir,
): CategoryPlace[] {
  if (field === "default") return results;
  const asc = dir === "asc";
  if (field === "price") {
    return [...results].sort((a, b) => {
      const pa = a.fuelPrices?.diesel ?? (asc ? Number.MAX_VALUE : -Number.MAX_VALUE);
      const pb = b.fuelPrices?.diesel ?? (asc ? Number.MAX_VALUE : -Number.MAX_VALUE);
      return asc ? pa - pb : pb - pa;
    });
  }
  return results;
}

function FuelPricePills({ prices }: { prices: FuelPrices }) {
  const pills: { label: string; value: number }[] = [];
  if (prices.diesel !== undefined) pills.push({ label: "Diesel", value: prices.diesel });
  if (prices.e5 !== undefined) pills.push({ label: "E5", value: prices.e5 });
  if (prices.e10 !== undefined) pills.push({ label: "E10", value: prices.e10 });
  if (pills.length === 0) return null;
  return (
    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
      {pills.map((p) => (
        <Chip
          key={p.label}
          label={
            <>
              {p.label} <FuelPrice value={p.value} />
            </>
          }
          size="small"
          variant="outlined"
          sx={{ fontSize: 11, height: 20, "& .MuiChip-label": { px: 0.75 } }}
        />
      ))}
    </Box>
  );
}

const TRANSIT_MODE_ICONS: Partial<Record<TransportMode, typeof TrainIcon>> = {
  rail: TrainIcon,
  tram: TramIcon,
  bus: DirectionsBusIcon,
};

function TransitStopCard({
  stop,
  onSelect,
  providers,
}: {
  stop: TransitStop;
  onSelect: (stop: TransitStop) => void;
  providers: Record<string, { label: string; url: string }> | undefined;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(stop)}
      sx={{
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: "pointer",
        px: 2,
        py: 1.5,
        "&:hover": { bgcolor: "rgba(0,0,0,0.06)" },
      }}
    >
      <Typography variant="body1" fontWeight={600} sx={{ mb: 0.25 }}>
        {stop.name}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        {Array.from(new Set(stop.modes)).map((m) => {
          const Icon = TRANSIT_MODE_ICONS[m] ?? DirectionsBusIcon;
          return <Icon key={m} sx={{ fontSize: 16, color: "text.secondary" }} />;
        })}
        {(() => {
          const attr = resolveProvider(providers, stop.provider);
          return (
            <Typography variant="caption" color="text.secondary">
              {attr.url ? (
                <Link
                  href={attr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  color="inherit"
                  underline="hover"
                  onClick={(e) => e.stopPropagation()}
                >
                  {attr.label}
                </Link>
              ) : (
                attr.label
              )}
            </Typography>
          );
        })()}
      </Box>
    </Box>
  );
}

function CategoryPlaceCard({
  place,
  isHovered,
  onSelect,
  onHover,
  onHoverEnd,
}: {
  place: CategoryPlace;
  isHovered: boolean;
  onSelect: (place: CategoryPlace) => void;
  onHover: (id: string) => void;
  onHoverEnd: () => void;
}) {
  const tagLabel = place.category
    ? place.category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : undefined;

  return (
    <Box
      component="button"
      type="button"
      onClick={() => onSelect(place)}
      onMouseEnter={() => onHover(place.id)}
      onMouseLeave={onHoverEnd}
      sx={{
        width: "100%",
        textAlign: "left",
        background: "none",
        border: "none",
        cursor: "pointer",
        px: 2,
        py: 1.5,
        bgcolor: isHovered ? "rgba(0,0,0,0.06)" : "transparent",
        "&:hover": { bgcolor: "rgba(0,0,0,0.06)" },
      }}
    >
      <Typography variant="body1" fontWeight={600} sx={{ mb: 0.25 }}>
        {place.name}
      </Typography>

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center", mb: 0.25 }}>
        {tagLabel && (
          <Typography variant="caption" color="text.secondary">
            {tagLabel}
          </Typography>
        )}
        {tagLabel && place.address && (
          <Typography variant="caption" color="text.secondary">
            ·
          </Typography>
        )}
        {place.address && (
          <Typography variant="caption" color="text.secondary">
            {place.address}
          </Typography>
        )}
      </Box>

      {(() => {
        const hours = parseOpeningHours(place.openingHours);
        if (hours) {
          return (
            <Typography variant="caption" color={hours.isOpen ? "success.main" : "error.main"}>
              {hours.isOpen ? `Open · ${hours.detail}` : `Closed · ${hours.detail}`}
            </Typography>
          );
        }
        if (place.isOpen !== undefined) {
          return (
            <Typography variant="caption" color={place.isOpen ? "success.main" : "error.main"}>
              {place.isOpen ? "Open" : "Closed"}
            </Typography>
          );
        }
        return null;
      })()}

      {place.fuelPrices && <FuelPricePills prices={place.fuelPrices} />}
    </Box>
  );
}

export function CategoryResultsPanel() {
  const {
    activeCategory,
    searchBbox,
    setSearchBbox,
    setMapMoved,
    hoveredCategoryPlaceId,
    setHoveredCategoryPlaceId,
  } = useCategorySearchStore();
  const { setSelectedPlace, setSidePanelCollapsed } = usePlaceStore();
  const { flyTo, mapRef, mapReady } = useMap();

  const { filtered, isLoading, isError, isTransitCategory } = useFilteredCategoryResults();
  const { data: transitStops, isPending: transitPending } = useTransitStops(
    isTransitCategory ? searchBbox : null,
  );
  const { data: providers } = useProviders();
  const transitLoading = isTransitCategory && transitPending;

  const [collapsed, setCollapsed] = useState(false);
  const [sortField, setSortField] = useState<SortField>("default");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [sortAnchorEl, setSortAnchorEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSidePanelCollapsed(collapsed);
  }, [collapsed, setSidePanelCollapsed]);

  useEffect(() => {
    return () => setSidePanelCollapsed(false);
  }, [setSidePanelCollapsed]);

  const prevCategoryRef = useRef(activeCategory);

  const results = filtered ? applyCategorySort(filtered, sortField, sortDir) : filtered;
  const hasFuelPrices = results?.some((p) => p.fuelPrices) ?? false;

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
    setCollapsed(false);
    setMapMoved(false);
  }, [activeCategory, mapReady]);

  // Clear prev category ref when category is cleared; reset sort on category change
  useEffect(() => {
    if (!activeCategory) {
      prevCategoryRef.current = null;
      setMapMoved(false);
    }
    setSortField("default");
    setSortDir("asc");
  }, [activeCategory, setMapMoved]);

  // Listen for map movement to show "Search in this area"
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !activeCategory) return;

    const onMoveEnd = () => setMapMoved(true);
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
    };
  }, [mapRef, mapReady, activeCategory, setMapMoved]);

  const handleSelectPlace = (place: CategoryPlace) => {
    flyTo(place.coordinates, 17);
    setSelectedPlace(categoryPlaceToPlace(place));
  };

  const handleSelectStop = (s: TransitStop) => {
    flyTo([s.lng, s.lat], 16);
    void resolveStopAsPlace(s).then(setSelectedPlace);
  };

  if (!activeCategory) return null;

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
          maxHeight: { xs: "65dvh", sm: "none" },
          overflowY: "auto",
          borderRadius: { xs: "16px 16px 0 0", sm: 0 },
          boxShadow: { xs: 6, sm: "4px 0 12px rgba(0,0,0,0.15)" },
          zIndex: 9,
          transform: { sm: collapsed ? "translateX(-100%)" : "translateX(0)" },
          transition: { sm: "transform 0.25s ease" },
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Results area */}
        <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" } }}>
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
              <Alert severity="error" variant="outlined">
                Failed to load results. Try again.
              </Alert>
            </Box>
          )}

          {/* Transit: empty state */}
          {isTransitCategory && !transitLoading && transitStops && transitStops.length === 0 && (
            <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
              <Typography color="text.secondary">No stops found in this area.</Typography>
            </Box>
          )}

          {/* Transit: results list */}
          {isTransitCategory && !transitLoading && transitStops && transitStops.length > 0 && (
            <>
              <Box sx={{ px: 2, pt: 1.5, pb: 0.5 }}>
                <Typography variant="body2" color="text.secondary">
                  {transitStops.length} stop{transitStops.length !== 1 ? "s" : ""}
                </Typography>
              </Box>
              {transitStops.map((stop, i) => (
                <Box key={stop.id}>
                  {i > 0 && <Divider sx={{ mx: 2 }} />}
                  <TransitStopCard stop={stop} onSelect={handleSelectStop} providers={providers} />
                </Box>
              ))}
            </>
          )}

          {/* Non-transit: empty state */}
          {!isTransitCategory && !isLoading && !isError && results && results.length === 0 && (
            <Box sx={{ px: 2, py: 4, textAlign: "center" }}>
              <Typography color="text.secondary">No results found in this area.</Typography>
            </Box>
          )}

          {/* Non-transit: results list */}
          {!isTransitCategory && !isLoading && results && results.length > 0 && (
            <>
              <Box sx={{ px: 2, pt: 1.5, pb: 0.5, display: "flex", alignItems: "center", gap: 1 }}>
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {results.length} result{results.length !== 1 ? "s" : ""}
                </Typography>

                {hasFuelPrices && (
                  <>
                    <Box
                      component="button"
                      type="button"
                      onClick={(e: React.MouseEvent<HTMLElement>) =>
                        setSortAnchorEl(e.currentTarget)
                      }
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        gap: 0.4,
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                        p: 0,
                        color: sortField !== "default" ? "primary.main" : "text.secondary",
                        fontSize: 12,
                        fontWeight: sortField !== "default" ? 600 : 400,
                        whiteSpace: "nowrap",
                      }}
                    >
                      <SortIcon sx={{ fontSize: 14 }} />
                      {sortField !== "default"
                        ? SORT_FIELDS.find((f) => f.value === sortField)?.label
                        : "Sort by"}
                    </Box>

                    {sortField !== "default" && (
                      <Box
                        component="button"
                        type="button"
                        onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
                        title={DIR_LABELS[sortDir]}
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          p: 0,
                          color: "primary.main",
                        }}
                      >
                        {sortDir === "asc" ? (
                          <ArrowUpwardIcon sx={{ fontSize: 14 }} />
                        ) : (
                          <ArrowDownwardIcon sx={{ fontSize: 14 }} />
                        )}
                      </Box>
                    )}

                    <Menu
                      anchorEl={sortAnchorEl}
                      open={Boolean(sortAnchorEl)}
                      onClose={() => setSortAnchorEl(null)}
                      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                      transformOrigin={{ vertical: "top", horizontal: "right" }}
                    >
                      {SORT_FIELDS.map((opt) => (
                        <MenuItem
                          key={opt.value}
                          selected={sortField === opt.value}
                          onClick={() => {
                            setSortField(opt.value);
                            setSortAnchorEl(null);
                          }}
                          sx={{ fontSize: 14 }}
                        >
                          {opt.label}
                        </MenuItem>
                      ))}
                    </Menu>
                  </>
                )}

                {hasFuelPrices &&
                  (() => {
                    const attr = results?.find((p) => p.fuelAttribution)?.fuelAttribution;
                    return attr ? (
                      <Link
                        href={attr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        underline="hover"
                        variant="caption"
                        sx={{ color: "text.disabled" }}
                      >
                        {attr.label}
                      </Link>
                    ) : null;
                  })()}
              </Box>
              {results.map((place, i) => (
                <Box key={place.id}>
                  {i > 0 && <Divider sx={{ mx: 2 }} />}
                  <CategoryPlaceCard
                    place={place}
                    isHovered={hoveredCategoryPlaceId === place.id}
                    onSelect={handleSelectPlace}
                    onHover={setHoveredCategoryPlaceId}
                    onHoverEnd={() => setHoveredCategoryPlaceId(null)}
                  />
                </Box>
              ))}
            </>
          )}
        </Box>
      </Paper>

      <SidebarCollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
    </>
  );
}
