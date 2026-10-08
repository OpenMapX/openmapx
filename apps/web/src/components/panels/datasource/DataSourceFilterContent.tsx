"use client";

import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CancelIcon from "@mui/icons-material/Cancel";
import SortIcon from "@mui/icons-material/Sort";
import Autocomplete, { type AutocompleteRenderValueGetItemProps } from "@mui/material/Autocomplete";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { DataSourceFilterDef, DataSourceResult } from "@openmapx/core";
import {
  applyClientSideFilters,
  createPlace,
  PANEL,
  splitFilters,
  useDataSourceSearch,
  useDataSourceStore,
  useDataSources,
  useOpeningHoursStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { isI18nToken } from "@openmapx/integration-framework/strings";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useDataSourceI18nResolver } from "@/components/panels/place/useDataSourceI18nResolver";
import { ResultItemName, ResultList, ResultListItem } from "@/components/ui/ResultListItem";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { translateDataSourceLabel, translateDataSourceSummary } from "@/lib/dataSourceSummaryI18n";
import { BrandMark } from "../shared/BrandMark";
import { DataSourcePartialNotice } from "./DataSourcePartialNotice";

/** Matches 3-decimal Euro prices like "2.119" within a summary string. */
const EURO_PRICE_GLOBAL_RE = /(\d+\.\d{2})(\d)\s*\u20ac/g;

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
        <span>{"\u00a0\u20ac"}</span>
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

function shouldShowOperatorCaption(result: DataSourceResult): boolean {
  if (!result.operator) return false;
  return !result.name.toLowerCase().startsWith(result.operator.toLowerCase());
}

/** Derive unique operator names from raw (pre-client-filter) results. */
function deriveOperatorOptions(results: DataSourceResult[]): string[] {
  const names = new Set<string>();
  for (const r of results) {
    if (r.operator && typeof r.operator === "string") names.add(r.operator);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

export function DataSourceFilterContent() {
  const t = useTranslations("dataSources");
  const tc = useTranslations("common");
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const resolveToken = useDataSourceI18nResolver(activeSource ?? undefined);
  const titleOf = (result: DataSourceResult) => result.name || resolveToken(result.fallbackName);
  const filters = useDataSourceStore((s) => s.filters);
  const searchBbox = useDataSourceStore((s) => s.searchBbox);
  const viewportZoom = useDataSourceStore((s) => s.viewportZoom);
  const setFilter = useDataSourceStore((s) => s.setFilter);
  const clearFilters = useDataSourceStore((s) => s.clearFilters);
  const selectItem = useDataSourceStore((s) => s.selectItem);
  const hoveredItemId = useDataSourceStore((s) => s.hoveredItemId);
  const setHoveredItemId = useDataSourceStore((s) => s.setHoveredItemId);
  const openingHoursFilter = useOpeningHoursStore((s) => s.openingHoursFilter);
  const { setSelectedPlace } = usePlaceStore();
  const { zoomIn } = useMap();
  const onHoverEnd = useCallback(() => setHoveredItemId(null), [setHoveredItemId]);
  const [sortAsc, setSortAsc] = useState(true);
  const [activeSortKey, setActiveSortKey] = useState<string | null>(null);

  const { data: sourcesData } = useDataSources();

  // Find metadata for the active source
  const sourceMeta = useMemo(() => {
    if (!activeSource || !sourcesData?.sources) return null;
    return sourcesData.sources.find((s) => s.id === activeSource) ?? null;
  }, [activeSource, sourcesData]);

  // Separate server-side filters using provider filter definitions
  const serverFilters = useMemo(
    () => splitFilters(filters, sourceMeta?.filters ?? []).serverFilters,
    [filters, sourceMeta?.filters],
  );

  // Only fetch when zoom is sufficient -- use searchBbox (not viewportBbox)
  const shouldFetch =
    activeSource !== null &&
    searchBbox !== null &&
    (sourceMeta ? viewportZoom >= sourceMeta.minZoom : true);

  const {
    data: rawResults,
    isLoading,
    isFetching,
    isError,
    partial,
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
  const filteredResults = useMemo(
    () => applyClientSideFilters(rawResults ?? [], filters, openingHoursFilter),
    [rawResults, filters, openingHoursFilter],
  );

  // Available sort options per data source
  const sortOptions = useMemo(() => {
    if (activeSource === "fuel") {
      const ft = filters.fuelType;
      const key = Array.isArray(ft) && ft.length > 0 ? String(ft[0]) : "diesel";
      return [{ key, labelKey: "price" as const }];
    }
    if (activeSource === "scooter-sharing") {
      return [
        { key: "range", labelKey: "range" as const },
        { key: "battery", labelKey: "battery" as const },
      ];
    }
    if (activeSource === "parking") {
      return [{ key: "freeSpaces", labelKey: "freeSpaces" as const }];
    }
    if (activeSource === "ev-charging") {
      return [
        { key: "powerKw", labelKey: "power" as const },
        { key: "available", labelKey: "availability" as const },
      ];
    }
    return [{ key: "available", labelKey: "availability" as const }];
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

  if (!sourceMeta) return null;

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

  return (
    <>
      {/* Filter sections + results */}
      <Box sx={{ flex: 1, overflowY: "auto", pt: { xs: 2, sm: "72px" }, px: 2, pb: 1.5 }}>
        {/* Clear all filters chip */}
        {hasActiveFilters && (
          <Box sx={{ mb: 1.5 }}>
            <Chip
              label={t("clearAllFilters")}
              size="small"
              onDelete={clearFilters}
              deleteIcon={<CancelIcon />}
              sx={{ fontSize: 12 }}
            />
          </Box>
        )}

        {/* Toggles render as switches, the charging speed as chips with the
            map markers' coloured dots, everything else as generic chips */}
        {sourceMeta.filters.map((filterDef) =>
          filterDef.type === "toggle" ? (
            <ToggleFilterSection
              key={filterDef.id}
              filterDef={filterDef}
              checked={Boolean(filters[filterDef.id])}
              onChange={(checked) => setFilter(filterDef.id, checked)}
            />
          ) : filterDef.id === "speed" ? (
            <SpeedFilterSection
              key={filterDef.id}
              filterDef={filterDef}
              currentValue={filters.speed}
              onToggle={handleToggleMultiSelect}
            />
          ) : (
            <ChipFilterSection
              key={filterDef.id}
              filterDef={filterDef}
              currentValue={filters[filterDef.id]}
              onToggle={handleToggleMultiSelect}
            />
          ),
        )}

        {/* Dynamic operator filter -- Autocomplete */}
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
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                  flex: 1,
                }}
              >
                {tc("resultsCount", { count: filteredResults.length })}
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
                  "& .MuiOutlinedInput-notchedOutline": { borderColor: BRAND },
                  "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: BRAND },
                  "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: BRAND },
                }}
              >
                <MenuItem value="" sx={{ fontSize: 12 }}>
                  {tc("none")}
                </MenuItem>
                {sortOptions.map((opt) => (
                  <MenuItem key={opt.key} value={opt.key} sx={{ fontSize: 12 }}>
                    {t(opt.labelKey)}
                  </MenuItem>
                ))}
              </Select>
              {activeSortKey && (
                <IconButton
                  size="small"
                  onClick={() => setSortAsc((v) => !v)}
                  title={sortAsc ? t("lowToHigh") : t("highToLow")}
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
            <ResultList
              items={sortedResults}
              getKey={(result) => result.id}
              renderItem={(result) => (
                <ResultListItem
                  onClick={() => {
                    if (!activeSource) return;
                    selectItem(activeSource, result.id);
                    setSelectedPlace(
                      createPlace({
                        primaryScheme: activeSource,
                        ids: { [activeSource]: result.id },
                        name: titleOf(result),
                        address: titleOf(result),
                        coordinates: result.coordinates,
                        category: sourceMeta?.placeCategory,
                        rawCategory: sourceMeta?.placeCategoryRaw,
                      }),
                    );
                    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
                  }}
                  onMouseEnter={() => setHoveredItemId(result.id)}
                  onMouseLeave={onHoverEnd}
                  selected={hoveredItemId === result.id}
                  hoverBg="var(--omx-hover-bg)"
                >
                  <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-start" }}>
                    {result.branding && (
                      <BrandMark
                        branding={result.branding}
                        fallbackName={result.operator ?? titleOf(result)}
                        size={26}
                      />
                    )}
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <ResultItemName>{titleOf(result)}</ResultItemName>
                      {shouldShowOperatorCaption(result) && (
                        <Typography
                          variant="caption"
                          sx={{
                            color: "text.secondary",
                            mb: 0.25,
                          }}
                        >
                          {result.operator}
                        </Typography>
                      )}
                      <Box
                        sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center" }}
                      >
                        {result.summary && (
                          <Typography
                            variant="caption"
                            sx={{
                              color: "text.secondary",
                            }}
                          >
                            <FormattedSummary
                              text={
                                isI18nToken(result.summary)
                                  ? resolveToken(result.summary)
                                  : (translateDataSourceSummary(result.summary, t) ??
                                    result.summary)
                              }
                            />
                          </Typography>
                        )}
                        {result.status && result.status !== "unknown" && (
                          <Typography
                            variant="caption"
                            sx={{
                              color:
                                result.status === "open" || result.status === "available"
                                  ? "success.main"
                                  : result.status === "closed" ||
                                      result.status === "empty" ||
                                      result.status === "inactive"
                                    ? "error.main"
                                    : result.status === "full"
                                      ? "warning.main"
                                      : "text.secondary",
                              fontWeight: 500,
                            }}
                          >
                            {result.status === "open"
                              ? tc("open")
                              : result.status === "closed"
                                ? tc("closed")
                                : result.status === "available"
                                  ? tc("available")
                                  : result.status === "empty"
                                    ? tc("empty")
                                    : result.status === "full"
                                      ? tc("full")
                                      : result.status === "inactive"
                                        ? tc("inactive")
                                        : null}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  </Box>
                </ResultListItem>
              )}
            />
          </Box>
        )}
      </Box>
      {partial === "area" && !belowMinZoom && !showLoading && !isError && (
        <>
          <Divider />
          <DataSourcePartialNotice onZoomIn={zoomIn} />
        </>
      )}
      {/* Status footer */}
      {(belowMinZoom ||
        showLoading ||
        isError ||
        !sourceMeta.showResultsList ||
        filteredResults.length === 0) && (
        <>
          <Divider />
          <Box sx={{ px: 2, py: 1.5, textAlign: "center" }}>
            {belowMinZoom ? (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {t("zoomInToSee")}
              </Typography>
            ) : showLoading ? (
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1 }}>
                <CircularProgress size={16} />
                <Typography
                  variant="body2"
                  sx={{
                    color: "text.secondary",
                  }}
                >
                  {tc("loading")}
                </Typography>
              </Box>
            ) : isError ? (
              <Typography variant="body2" color="error">
                {t("failedToLoadData")}
              </Typography>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  color: "text.secondary",
                }}
              >
                {tc("stationsInView", { count: filteredResults.length })}
              </Typography>
            )}
          </Box>
        </>
      )}
    </>
  );
}

function FilterOptionChip({
  label,
  selected,
  icon,
  onClick,
}: {
  label: string;
  selected: boolean;
  icon?: React.ReactElement;
  onClick: () => void;
}) {
  return (
    <Chip
      label={label}
      size="small"
      variant={selected ? "filled" : "outlined"}
      {...(icon ? { icon } : {})}
      onClick={onClick}
      sx={{
        fontSize: 12,
        ...(selected && {
          bgcolor: BRAND,
          color: "#fff",
          "&:hover": { bgcolor: "var(--omx-brand-hover)" },
        }),
      }}
    />
  );
}

/** Generic Chip Filter Section -- used for every multi-select filter */

const SPEED_COLORS: Record<string, string> = {
  slow: "#4CAF50",
  fast: "#FF9800",
  "ultra-rapid": "#F44336",
};

function ChipFilterSection({
  filterDef,
  currentValue,
  onToggle,
  renderIcon,
}: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
  renderIcon?: (optionId: string | number) => React.ReactElement | undefined;
}) {
  const t = useTranslations("dataSources");
  if (filterDef.type !== "multi-select" || !filterDef.options) return null;

  const selected = (currentValue as (string | number)[] | undefined) ?? [];

  return (
    <Box sx={{ mb: 2 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 600,
          mb: 1,
        }}
      >
        {translateDataSourceLabel(filterDef.label, t)}
      </Typography>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {filterDef.options.map((opt) => {
          const isSelected = selected.includes(opt.id);
          const icon = renderIcon?.(opt.id);
          return (
            <FilterOptionChip
              key={String(opt.id)}
              label={translateDataSourceLabel(opt.label, t)}
              selected={isSelected}
              icon={icon}
              onClick={() => onToggle(filterDef.id, opt.id)}
            />
          );
        })}
      </Box>
    </Box>
  );
}

function SpeedFilterSection(props: {
  filterDef: DataSourceFilterDef;
  currentValue: unknown;
  onToggle: (filterId: string, optionId: string | number) => void;
}) {
  return (
    <ChipFilterSection
      {...props}
      renderIcon={(optionId) => (
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            bgcolor: SPEED_COLORS[String(optionId)] ?? "#9E9E9E",
            flexShrink: 0,
            ml: "8px !important",
            mr: "-2px !important",
          }}
        />
      )}
    />
  );
}

/** Toggle Filter Section -- a single switch bound to a boolean filter value */

function ToggleFilterSection({
  filterDef,
  checked,
  onChange,
}: {
  filterDef: DataSourceFilterDef;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslations("dataSources");
  return (
    <Box sx={{ mb: 2 }}>
      <FormControlLabel
        control={
          <Switch size="small" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        }
        label={
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {translateDataSourceLabel(filterDef.label, t)}
          </Typography>
        }
      />
    </Box>
  );
}

/** Operator Section -- MUI Autocomplete with multi-select */

function OperatorSection({
  operatorOptions,
  selectedOperators,
  onChangeOperators,
}: {
  operatorOptions: string[];
  selectedOperators: string[];
  onChangeOperators: (operators: string[]) => void;
}) {
  const t = useTranslations("dataSources");
  return (
    <Box sx={{ mb: 2 }}>
      <Typography
        variant="body2"
        sx={{
          fontWeight: 600,
          mb: 1,
        }}
      >
        {t("operator")}
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
            placeholder={selectedOperators.length === 0 ? t("searchOperators") : ""}
            variant="outlined"
            size="small"
          />
        )}
        renderValue={(value: string[], getItemProps: AutocompleteRenderValueGetItemProps<true>) =>
          value.map((option, index) => {
            const { key, ...rest } = getItemProps({ index });
            return (
              <Chip
                key={key}
                label={option}
                size="small"
                {...rest}
                sx={{
                  fontSize: 11,
                  bgcolor: BRAND,
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
              boxShadow: "0 2px 8px var(--omx-shadow-soft)",
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
