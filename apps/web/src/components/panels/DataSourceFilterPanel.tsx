"use client";

import BlockIcon from "@mui/icons-material/Block";
import CancelIcon from "@mui/icons-material/Cancel";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import CloseIcon from "@mui/icons-material/Close";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import ScheduleIcon from "@mui/icons-material/Schedule";
import Autocomplete from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import type { DataSourceFilterDef, DataSourceResult } from "@openmapx/core";
import {
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
    if (r.operator) names.add(r.operator);
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
      out = out.filter((r) => r.operator && operatorSet.has(r.operator));
    }
  }

  return out;
}

export function DataSourceFilterPanel() {
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const filters = useDataSourceStore((s) => s.filters);
  const selectedItem = useDataSourceStore((s) => s.selectedItem);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const setFilter = useDataSourceStore((s) => s.setFilter);
  const clearFilters = useDataSourceStore((s) => s.clearFilters);
  const setSidePanelCollapsed = usePlaceStore((s) => s.setSidePanelCollapsed);
  const [collapsed, setCollapsed] = useState(false);

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
    isError,
  } = useDataSourceSearch(
    shouldFetch ? activeSource : null,
    shouldFetch ? searchBbox : null,
    serverFilters,
  );

  // Derive operator options from raw (pre-client-filter) results
  const operatorOptions = useMemo(() => deriveOperatorOptions(rawResults ?? []), [rawResults]);

  // Apply client-side filters for display count
  const filteredResults = useMemo(
    () => applyClientFilters(rawResults ?? [], filters),
    [rawResults, filters],
  );

  // Check if any filters are active
  const hasActiveFilters = Object.values(filters).some((v) => {
    if (Array.isArray(v)) return v.length > 0;
    return v !== undefined && v !== null;
  });

  // Hide when no active source, no meta, or detail view is showing
  if (!activeSource || !sourceMeta || selectedItem !== null) return null;

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
        {/* Header */}
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            px: 2,
            pt: { xs: 2, sm: "72px" },
            pb: 1,
          }}
        >
          <Typography variant="h6" fontWeight={600} sx={{ flex: 1, minWidth: 0, pr: 1 }}>
            {sourceMeta.name}
          </Typography>
          <IconButton
            onClick={() => setActiveSource(null)}
            aria-label="Close"
            size="small"
            sx={{ mt: -0.5 }}
          >
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Attribution */}
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Data from{" "}
            <Link
              href="https://openchargemap.org"
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              OpenChargeMap
            </Link>
            {" & "}
            <Link
              href="https://www.openstreetmap.org"
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              OpenStreetMap
            </Link>
          </Typography>
        </Box>

        <Divider />

        {/* Filter sections */}
        <Box sx={{ flex: 1, overflowY: "auto", px: 2, py: 1.5 }}>
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
        </Box>

        <Divider />

        {/* Status footer */}
        <Box sx={{ px: 2, py: 1.5, textAlign: "center" }}>
          {belowMinZoom ? (
            <Typography variant="body2" color="text.secondary">
              Zoom in to see stations
            </Typography>
          ) : isLoading ? (
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1 }}>
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
