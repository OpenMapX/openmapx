"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import BlockIcon from "@mui/icons-material/Block";
import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import ScheduleIcon from "@mui/icons-material/Schedule";
import SortIcon from "@mui/icons-material/Sort";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { DataSourceFilterDef, DataSourceResult } from "@openmapx/core";
import {
  useCategorySearchStore,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  usePlaceStore,
} from "@openmapx/core";
import { useEffect, useMemo, useState } from "react";
import { SidebarCollapseToggle } from "@/components/ui/SidebarCollapseToggle";
import { PANEL_WIDTH } from "@/lib/layout";
import { TEAL } from "@/lib/theme";

/** Filter IDs that are applied client-side instead of being sent to the API. */
const CLIENT_SIDE_FILTER_IDS = new Set(["operator", "speed"]);

/** Matches 3-decimal Euro prices like "2.119 €" within a summary string. */
const EURO_PRICE_GLOBAL_RE = /(\d+\.\d{2})(\d)\s*€/g;

/** Renders a summary string with 3-decimal Euro prices having the last digit in superscript. */
function FormattedSummary({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  const re = new RegExp(EURO_PRICE_GLOBAL_RE.source, "g");
  let match = re.exec(text);
  let key = 0;

  while (match !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={key++} style={{ display: "inline-flex", alignItems: "flex-start" }}>
        <span>{match[1]}</span>
        <span style={{ fontSize: "0.65em", marginTop: "0.2em" }}>{match[2]}</span>
        <span>&nbsp;€</span>
      </span>,
    );
    lastIndex = re.lastIndex;
    match = re.exec(text);
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}

/**
 * Connector label substrings considered "common" — shown by default.
 * Matched case-insensitively against each option's label.
 */
const COMMON_CONNECTOR_PATTERNS = [
  "type 2",
  "ccs",
  "chademo",
  "nacs",
  "tesla",
  "type 1",
  "j1772",
  "schuko",
];

/** Determines if a connector option label is a "common" connector. */
function isCommonConnector(label: string): boolean {
  const lower = label.toLowerCase();
  return COMMON_CONNECTOR_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Status group definitions. Each group maps to a set of OCM status label
 * substrings. When a user selects a group, all matching OCM status IDs are
 * added to the filter.
 */
interface StatusGroup {
  label: string;
  icon: React.ReactNode;
  patterns: string[];
}

const STATUS_GROUPS: StatusGroup[] = [
  {
    label: "Operational",
    icon: <CheckCircleOutlineIcon fontSize="small" sx={{ color: "#4caf50" }} />,
    patterns: ["operational"],
  },
  {
    label: "Non-operational",
    icon: <ErrorOutlineIcon fontSize="small" sx={{ color: "#f44336" }} />,
    patterns: ["not operational", "temporarily unavailable", "unavailable"],
  },
  {
    label: "Planned / Other",
    icon: <ScheduleIcon fontSize="small" sx={{ color: "#9e9e9e" }} />,
    patterns: ["planned", "removed", "unknown", "decommissioned"],
  },
];

/** Map an OCM status label to a group index. Non-operational must be checked before operational. */
function statusGroupIndex(statusLabel: string): number {
  const lower = statusLabel.toLowerCase();
  // "partly operational" stays with operational — check non-operational patterns
  // first but exclude "partly"
  if (!lower.includes("partly") && STATUS_GROUPS[1].patterns.some((p) => lower.includes(p)))
    return 1;
  // Then check operational (catches "Operational" and "Partly Operational")
  if (STATUS_GROUPS[0].patterns.some((p) => lower.includes(p))) return 0;
  // Everything else → Planned / Other
  return STATUS_GROUPS.length - 1;
}

/**
 * Access type grouping — maps option labels to an icon and group label.
 */
interface AccessGroup {
  label: string;
  icon: React.ReactNode;
  patterns: string[];
}

const ACCESS_GROUPS: AccessGroup[] = [
  {
    label: "Public",
    icon: <LockOpenIcon fontSize="small" />,
    patterns: ["public"],
  },
  {
    label: "Membership Required",
    icon: <LockIcon fontSize="small" />,
    patterns: ["membership"],
  },
  {
    label: "Visitors / Customers",
    icon: <LockOpenIcon fontSize="small" />,
    patterns: ["visitors", "customers"],
  },
  {
    label: "Private / Restricted",
    icon: <BlockIcon fontSize="small" />,
    patterns: ["private", "restricted", "staff"],
  },
];

function accessGroupIndex(label: string): number {
  const lower = label.toLowerCase();
  for (let i = 0; i < ACCESS_GROUPS.length; i++) {
    if (ACCESS_GROUPS[i].patterns.some((p) => lower.includes(p))) return i;
  }
  return ACCESS_GROUPS.length - 1;
}

/** Derive unique operator names from raw (pre-client-filter) results. */
function deriveOperatorOptions(results: DataSourceResult[]): string[] {
  const names = new Set<string>();
  for (const r of results) {
    if (r.operator && typeof r.operator === "string") names.add(r.operator);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/** Apply client-side operator/speed filters — same logic as DataSourceLayer. */
function applyClientFilters(
  results: DataSourceResult[],
  filters: Record<string, unknown>,
): DataSourceResult[] {
  let out = results;

  const speedFilter = filters.speed;
  if (speedFilter) {
    const speedValues = Array.isArray(speedFilter)
      ? (speedFilter as string[])
      : [String(speedFilter)];
    if (speedValues.length > 0) {
      const speedSet = new Set(speedValues);
      out = out.filter((r) => speedSet.has(r.variant));
    }
  }

  const operatorFilter = filters.operator;
  if (operatorFilter) {
    const opValues = Array.isArray(operatorFilter)
      ? (operatorFilter as string[])
      : [String(operatorFilter)];
    if (opValues.length > 0) {
      const operatorSet = new Set(opValues);
      out = out.filter((r) => typeof r.operator === "string" && operatorSet.has(r.operator));
    }
  }

  return out;
}

export function DataSourceFilterPanel() {
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setFilter = useDataSourceStore((s) => s.setFilter);
  const clearFilters = useDataSourceStore((s) => s.clearFilters);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const openingHoursFilter = useCategorySearchStore((s) => s.openingHoursFilter);
  const { setSelectedPlace, setSidePanelCollapsed } = usePlaceStore();
  const [collapsed, setCollapsed] = useState(false);
  const [sortAsc, setSortAsc] = useState(true);
  const [activeSortKey, setActiveSortKey] = useState<string | null>(null);

  useEffect(() => {
    setSidePanelCollapsed(collapsed);
  }, [collapsed, setSidePanelCollapsed]);

  useEffect(() => {
    return () => setSidePanelCollapsed(false);
  }, [setSidePanelCollapsed]);

  const { data: sourcesData } = useDataSources();

  // Find metadata for the active source
  const sourceMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  // Separate client-side vs server-side filters (same logic as DataSourceLayer)
  const serverFilters = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filters)) {
      if (!CLIENT_SIDE_FILTER_IDS.has(key)) {
        result[key] = value;
      }
    }
    return result;
  }, [filters]);

  // Only fetch when zoom is sufficient — use searchBbox (not viewportBbox)
  const shouldFetch =
    activeSource !== null &&
    searchBbox !== null &&
    (sourceMeta ? viewportZoom >= sourceMeta.minZoom : true);

  const {
    data: rawResults,
    isLoading,
    isFetching,
    isError,
  } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  // Show loading when either initial load or refetching with new bbox
  const showLoading = isLoading || (isFetching && (!rawResults || rawResults.length === 0));

  // Derive operator options from raw (pre-client-filter) results
  const operatorOptions = useMemo(() => deriveOperatorOptions(rawResults ?? []), [rawResults]);

  // Apply client-side filters for display count
  const filteredResults = useMemo(() => {
    let results = applyClientFilters(rawResults ?? [], filters);
    // "Open now" filter from the opening hours chip
    if (openingHoursFilter === "open_now") {
      results = results.filter((r) => r.variant === "open");
    }
    return results;
  }, [rawResults, filters, openingHoursFilter]);

  // Available sort options per data source
  const sortOptions = useMemo(() => {
    if (activeSource === "fuel") {
      const ft = filters.fuelType;
      const key = Array.isArray(ft) && ft.length > 0 ? String(ft[0]) : "diesel";
      return [{ key, label: "Price" }];
    }
    if (activeSource === "scooter-sharing") {
      return [
        { key: "range", label: "Range" },
        { key: "battery", label: "Battery" },
      ];
    }
    return [{ key: "available", label: "Availability" }];
  }, [activeSource, filters.fuelType]);

  // Sort results when a sort key is active
  const sortedResults = useMemo(() => {
    if (!activeSortKey) return filteredResults;
    return [...filteredResults].sort((a, b) => {
      const va = a.sortValues?.[activeSortKey] ?? (sortAsc ? Number.MAX_VALUE : -Number.MAX_VALUE);
      const vb = b.sortValues?.[activeSortKey] ?? (sortAsc ? Number.MAX_VALUE : -Number.MAX_VALUE);
      return sortAsc ? va - vb : vb - va;
    });
  }, [filteredResults, activeSortKey, sortAsc]);

  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some((v) => {
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null;
  });

  // Hide when no active source or no meta
  if (!activeSource || !sourceMeta) return null;

  const belowMinZoom = sourceMeta && viewportZoom < sourceMeta.minZoom;

  const handleToggleMultiSelect = (filterId: string, optionId: string | number) => {
    const current = (filters[filterId] as (string | number)[] | undefined) ?? [];
    const idx = current.indexOf(optionId);
    if (idx >= 0) {
      setFilter(
        filterId,
        current.filter((v) => v !== optionId),
      );
    } else {
      setFilter(filterId, [...current, optionId]);
    }
  };

  /** Toggle an entire set of option IDs at once (for grouped statuses / access). */
  const handleToggleGroup = (filterId: string, optionIds: (string | number)[]) => {
    const current = (filters[filterId] as (string | number)[] | undefined) ?? [];
    const allSelected = optionIds.every((id) => current.includes(id));
    if (allSelected) {
      // Remove all IDs in this group
      setFilter(
        filterId,
        current.filter((v) => !optionIds.includes(v)),
      );
    } else {
      // Add missing IDs from this group
      const toAdd = optionIds.filter((id) => !current.includes(id));
      setFilter(filterId, [...current, ...toAdd]);
    }
  };

  // Build filter lookup by id
  const filterMap = new Map<string, DataSourceFilterDef>();
  for (const f of sourceMeta.filters) {
    filterMap.set(f.id, f);
  }

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
        {/* Filter sections + results */}
        <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" }, px: 2, pb: 1.5 }}>
          {/* Clear all filters chip */}
          {hasActiveFilters && (
            <Box sx={{ mb: 1.5 }}>
              <Chip
                label="Clear all filters"
                size="small"
                onDelete={clearFilters}
                deleteIcon={<CancelIcon />}
                sx={{ fontSize: 12 }}
              />
            </Box>
          )}

          {/* Connector Type — curated common connectors + expandable "Show all" */}
          {(() => {
            const def = filterMap.get("connectorType");
            return def ? (
              <ConnectorTypeSection
                filterDef={def}
                currentValue={filters.connectorType}
                onToggle={handleToggleMultiSelect}
              />
            ) : null;
          })()}

          {/* Charging Speed — chips with colored dots matching map markers */}
          {(() => {
            const def = filterMap.get("speed");
            return def ? (
              <SpeedFilterSection
                filterDef={def}
                currentValue={filters.speed}
                onToggle={handleToggleMultiSelect}
              />
            ) : null;
          })()}

          {/* Access Type — grouped with icons */}
          {(() => {
            const def = filterMap.get("usageType");
            return def ? (
              <AccessTypeSection
                filterDef={def}
                currentValue={filters.usageType}
                onToggleGroup={handleToggleGroup}
              />
            ) : null;
          })()}

          {/* Status — consolidated into 3 groups */}
          {(() => {
            const def = filterMap.get("status");
            return def ? (
              <StatusSection
                filterDef={def}
                currentValue={filters.status}
                onToggleGroup={handleToggleGroup}
              />
            ) : null;
          })()}

          {/* Remaining filters not handled above — fallback to generic chips */}
          {sourceMeta.filters
            .filter((f) => !["connectorType", "speed", "usageType", "status"].includes(f.id))
            .map((filterDef) => (
              <ChipFilterSection
                key={filterDef.id}
                filterDef={filterDef}
                currentValue={filters[filterDef.id]}
                onToggle={handleToggleMultiSelect}
              />
            ))}

          {/* Dynamic operator filter — Autocomplete */}
          {operatorOptions.length > 0 && (
            <OperatorSection
              operatorOptions={operatorOptions}
              selectedOperators={(filters.operator as string[] | undefined) ?? []}
              onChangeOperators={(ops) => setFilter("operator", ops)}
            />
          )}

          {/* Results list (for data sources like fuel that want individual results) */}
          {sourceMeta.showResultsList && !showLoading && filteredResults.length > 0 && (
            <Box sx={{ mx: -2 }}>
              <Divider />
              <Box
                sx={{
                  px: 2,
                  pt: 1.5,
                  pb: 0.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                }}
              >
                <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                  {filteredResults.length} result{filteredResults.length !== 1 ? "s" : ""}
                </Typography>

                {/* Sort controls */}
                <Select
                  size="small"
                  value={activeSortKey ?? ""}
                  displayEmpty
                  onChange={(e) => setActiveSortKey(e.target.value || null)}
                  IconComponent={() => null}
                  startAdornment={
                    <SortIcon sx={{ fontSize: 14, mr: 0.5, color: "text.secondary" }} />
                  }
                  sx={{
                    fontSize: 12,
                    height: 28,
                    "& .MuiSelect-select": { py: 0, pl: 0.5, pr: "8px !important" },
                    "& .MuiOutlinedInput-notchedOutline": { borderColor: TEAL },
                    "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: TEAL },
                    "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: TEAL },
                  }}
                >
                  <MenuItem value="" sx={{ fontSize: 12 }}>
                    None
                  </MenuItem>
                  {sortOptions.map((opt) => (
                    <MenuItem key={opt.key} value={opt.key} sx={{ fontSize: 12 }}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </Select>
                {activeSortKey && (
                  <IconButton
                    size="small"
                    onClick={() => setSortAsc((v) => !v)}
                    title={sortAsc ? "Low to high" : "High to low"}
                    sx={{ p: 0.25 }}
                  >
                    {sortAsc ? (
                      <ArrowUpwardIcon sx={{ fontSize: 16 }} />
                    ) : (
                      <ArrowDownwardIcon sx={{ fontSize: 16 }} />
                    )}
                  </IconButton>
                )}
              </Box>
              {sortedResults.map((result, i) => (
                <Box key={result.id}>
                  {i > 0 && <Divider sx={{ mx: 2 }} />}
                  <Box
                    component="button"
                    type="button"
                    onClick={() => {
                      if (!activeSource) return;
                      selectItem(activeSource, result.id);
                      // Set place directly from result data so the floating card
                      // shows immediately with correct name/coordinates/summary
                      setSelectedPlace({
                        id: result.id,
                        name: result.name,
                        address: result.name,
                        coordinates: result.coordinates,
                        category: sourceMeta?.placeCategory,
                        rawCategory: sourceMeta?.placeCategoryRaw,
                      });
                    }}
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
                      {result.name}
                    </Typography>
                    <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center" }}>
                      {result.summary && (
                        <Typography variant="caption" color="text.secondary">
                          <FormattedSummary text={result.summary} />
                        </Typography>
                      )}
                      {result.status && result.status !== "unknown" && (
                        <Typography
                          variant="caption"
                          sx={{
                            color:
                              result.status === "open" || result.status === "available"
                                ? "success.main"
                                : result.status === "closed" || result.status === "empty"
                                  ? "error.main"
                                  : result.status === "full"
                                    ? "warning.main"
                                    : "text.secondary",
                            fontWeight: 500,
                          }}
                        >
                          {result.status === "open"
                            ? "Open"
                            : result.status === "closed"
                              ? "Closed"
                              : result.status === "available"
                                ? "Available"
                                : result.status === "empty"
                                  ? "Empty"
                                  : result.status === "full"
                                    ? "Full"
                                    : null}
                        </Typography>
                      )}
                    </Box>
                  </Box>
                </Box>
              ))}
            </Box>
          )}
        </Box>

        {/* Status footer — show when below min zoom, loading, error, no results list, or results list is empty */}
        {(belowMinZoom ||
          showLoading ||
          isError ||
          !sourceMeta.showResultsList ||
          filteredResults.length === 0) && (
          <>
            <Divider />
            <Box sx={{ px: 2, py: 1.5, textAlign: "center" }}>
              {belowMinZoom ? (
                <Typography variant="body2" color="text.secondary">
                  Zoom in to see stations
                </Typography>
              ) : showLoading ? (
                <Box
                  sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1 }}
                >
                  <CircularProgress size={16} />
                  <Typography variant="body2" color="text.secondary">
                    Loading...
                  </Typography>
                </Box>
              ) : isError ? (
                <Typography variant="body2" color="error">
                  Failed to load data. Try again.
                </Typography>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {filteredResults.length} station{filteredResults.length !== 1 ? "s" : ""} in view
                </Typography>
              )}
            </Box>
          </>
        )}
      </Paper>

      <SidebarCollapseToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
    </>
  );
}

/** Connector Type Section — common chips + expandable "Show all" */

function ConnectorTypeSection({
  filterDef,
  currentValue,
  onToggle,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
}) {
  const [showAll, setShowAll] = useState(false);

  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];
  const commonOptions = filterDef.options.filter((opt) => isCommonConnector(opt.label));
  const otherOptions = filterDef.options.filter((opt) => !isCommonConnector(opt.label));

  // If a non-common connector is selected, auto-expand the "show all" section
  const hasSelectedOther = otherOptions.some((opt) => selected.includes(opt.id));

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
        {filterDef.label}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {commonOptions.map((opt) => {
          const isSelected = selected.includes(opt.id);
          return (
            <Chip
              key={String(opt.id)}
              label={opt.label}
              size="small"
              variant={isSelected ? "filled" : "outlined"}
              onClick={() => onToggle(filterDef.id, opt.id)}
              sx={{
                fontSize: 12,
                ...(isSelected && {
                  bgcolor: TEAL,
                  color: "#fff",
                  "&:hover": { bgcolor: "#006475" },
                }),
              }}
            />
          );
        })}
      </Box>

      {otherOptions.length > 0 && (
        <>
          <Box
            component="button"
            onClick={() => setShowAll((v) => !v)}
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              mt: 1,
              p: 0,
              border: "none",
              background: "none",
              cursor: "pointer",
              color: TEAL,
              fontSize: 12,
              fontFamily: "inherit",
            }}
          >
            <ExpandMoreIcon
              sx={{
                fontSize: 16,
                transform: showAll || hasSelectedOther ? "rotate(180deg)" : "rotate(0deg)",
                transition: "transform 0.2s",
              }}
            />
            {showAll || hasSelectedOther
              ? "Show fewer"
              : `Show all ${filterDef.options.length} types`}
          </Box>

          <Collapse in={showAll || hasSelectedOther}>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 1 }}>
              {otherOptions.map((opt) => {
                const isSelected = selected.includes(opt.id);
                return (
                  <Chip
                    key={String(opt.id)}
                    label={opt.label}
                    size="small"
                    variant={isSelected ? "filled" : "outlined"}
                    onClick={() => onToggle(filterDef.id, opt.id)}
                    sx={{
                      fontSize: 12,
                      ...(isSelected && {
                        bgcolor: TEAL,
                        color: "#fff",
                        "&:hover": { bgcolor: "#006475" },
                      }),
                    }}
                  />
                );
              })}
            </Box>
          </Collapse>
        </>
      )}
    </Box>
  );
}

/** Generic Chip Filter Section — used for any unknown filter */

function ChipFilterSection({
  filterDef,
  currentValue,
  onToggle,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
}) {
  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
        {filterDef.label}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {filterDef.options.map((opt) => {
          const isSelected = selected.includes(opt.id);
          return (
            <Chip
              key={String(opt.id)}
              label={opt.label}
              size="small"
              variant={isSelected ? "filled" : "outlined"}
              onClick={() => onToggle(filterDef.id, opt.id)}
              sx={{
                fontSize: 12,
                ...(isSelected && {
                  bgcolor: TEAL,
                  color: "#fff",
                  "&:hover": { bgcolor: "#006475" },
                }),
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/** Speed Filter Section — chips with colored dots matching map markers */

const SPEED_COLORS: Record<string, string> = {
  slow: "#4CAF50",
  fast: "#FF9800",
  "ultra-rapid": "#F44336",
};

function SpeedFilterSection({
  filterDef,
  currentValue,
  onToggle,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
}) {
  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
        {filterDef.label}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {filterDef.options.map((opt) => {
          const isSelected = selected.includes(opt.id);
          const dotColor = SPEED_COLORS[String(opt.id)] ?? "#9E9E9E";
          return (
            <Chip
              key={String(opt.id)}
              label={opt.label}
              size="small"
              variant={isSelected ? "filled" : "outlined"}
              icon={
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: dotColor,
                    flexShrink: 0,
                    ml: "8px !important",
                    mr: "-2px !important",
                  }}
                />
              }
              onClick={() => onToggle(filterDef.id, opt.id)}
              sx={{
                fontSize: 12,
                ...(isSelected && {
                  bgcolor: TEAL,
                  color: "#fff",
                  "&:hover": { bgcolor: "#006475" },
                }),
              }}
            />
          );
        })}
      </Box>
    </Box>
  );
}

/** Access Type Section — vertical list with icons, grouped */

function AccessTypeSection({
  filterDef,
  currentValue,
  onToggleGroup,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggleGroup: (filterId: string, optionIds: (string | number)[]) => void;
}) {
  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];

  // Group options by access group, keeping original labels for tooltip
  const opts = filterDef.options ?? [];
  const groups = ACCESS_GROUPS.map((group) => {
    const matchingOptions = opts.filter(
      (opt) => accessGroupIndex(opt.label) === ACCESS_GROUPS.indexOf(group),
    );
    return {
      ...group,
      optionIds: matchingOptions.map((o) => o.id),
      optionLabels: matchingOptions.map((o) => o.label),
    };
  }).filter((g) => g.optionIds.length > 0);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
        {filterDef.label}
      </Typography>
      <List dense disablePadding>
        {groups.map((group) => {
          const allSelected = group.optionIds.every((id) => selected.includes(id));
          return (
            <ListItemButton
              key={group.label}
              onClick={() => onToggleGroup(filterDef.id, group.optionIds)}
              selected={allSelected}
              sx={{
                borderRadius: 1,
                mb: 0.25,
                py: 0.5,
                ...(allSelected && {
                  bgcolor: `${TEAL}14`,
                  "&.Mui-selected": {
                    bgcolor: `${TEAL}14`,
                    "&:hover": { bgcolor: `${TEAL}22` },
                  },
                }),
              }}
            >
              <ListItemIcon
                sx={{
                  minWidth: 32,
                  color: allSelected ? TEAL : "text.secondary",
                }}
              >
                {group.icon}
              </ListItemIcon>
              <ListItemText
                primary={group.label}
                primaryTypographyProps={{
                  variant: "body2",
                  fontWeight: allSelected ? 600 : 400,
                  color: allSelected ? TEAL : "text.primary",
                }}
              />
              {group.optionLabels.length > 1 && (
                <Tooltip title={group.optionLabels.join(", ")} placement="right" arrow>
                  <InfoOutlinedIcon sx={{ fontSize: 16, color: "text.disabled", ml: 0.5 }} />
                </Tooltip>
              )}
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

/** Status Section — 3 consolidated groups with icons */

function StatusSection({
  filterDef,
  currentValue,
  onToggleGroup,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggleGroup: (filterId: string, optionIds: (string | number)[]) => void;
}) {
  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];

  // Group OCM status options into the 3 consolidated groups, keeping labels for tooltip
  const opts = filterDef.options ?? [];
  const groups = STATUS_GROUPS.map((group, gi) => {
    const matchingOptions = opts.filter((opt) => statusGroupIndex(opt.label) === gi);
    return {
      ...group,
      optionIds: matchingOptions.map((o) => o.id),
      optionLabels: matchingOptions.map((o) => o.label),
    };
  }).filter((g) => g.optionIds.length > 0);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
        {filterDef.label}
      </Typography>
      <List dense disablePadding>
        {groups.map((group) => {
          const allSelected = group.optionIds.every((id) => selected.includes(id));
          return (
            <ListItemButton
              key={group.label}
              onClick={() => onToggleGroup(filterDef.id, group.optionIds)}
              selected={allSelected}
              sx={{
                borderRadius: 1,
                mb: 0.25,
                py: 0.5,
                ...(allSelected && {
                  bgcolor: `${TEAL}14`,
                  "&.Mui-selected": {
                    bgcolor: `${TEAL}14`,
                    "&:hover": { bgcolor: `${TEAL}22` },
                  },
                }),
              }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>{group.icon}</ListItemIcon>
              <ListItemText
                primary={group.label}
                primaryTypographyProps={{
                  variant: "body2",
                  fontWeight: allSelected ? 600 : 400,
                  color: allSelected ? TEAL : "text.primary",
                }}
              />
              {group.optionLabels.length > 1 && (
                <Tooltip title={group.optionLabels.join(", ")} placement="right" arrow>
                  <InfoOutlinedIcon sx={{ fontSize: 16, color: "text.disabled", ml: 0.5 }} />
                </Tooltip>
              )}
            </ListItemButton>
          );
        })}
      </List>
    </Box>
  );
}

/** Operator Section — MUI Autocomplete with multi-select */

function OperatorSection({
  operatorOptions,
  selectedOperators,
  onChangeOperators,
}: {
  operatorOptions: string[];
  selectedOperators: string[];
  onChangeOperators: (operators: string[]) => void;
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" fontWeight={600} sx={{ mb: 1 }}>
        Operator
      </Typography>
      <Autocomplete
        multiple
        size="small"
        options={operatorOptions}
        value={selectedOperators}
        onChange={(_event, newValue) => onChangeOperators(newValue)}
        limitTags={3}
        disableCloseOnSelect
        renderInput={(params) => (
          <TextField
            {...params}
            placeholder={selectedOperators.length === 0 ? "Search operators..." : ""}
            variant="outlined"
            size="small"
          />
        )}
        renderTags={(value, getTagProps) =>
          value.map((option, index) => {
            const { key, ...rest } = getTagProps({ index });
            return (
              <Chip
                key={key}
                label={option}
                size="small"
                {...rest}
                sx={{
                  fontSize: 11,
                  bgcolor: TEAL,
                  color: "#fff",
                  "& .MuiChip-deleteIcon": {
                    color: "rgba(255,255,255,0.7)",
                    "&:hover": { color: "#fff" },
                  },
                }}
              />
            );
          })
        }
        slotProps={{
          paper: {
            sx: {
              border: "1px solid",
              borderColor: "divider",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              mt: 0.5,
            },
          },
        }}
        sx={{
          "& .MuiOutlinedInput-root": {
            fontSize: 13,
          },
        }}
      />
    </Box>
  );
}
