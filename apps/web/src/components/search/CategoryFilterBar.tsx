"use client";

import AccessibleIcon from "@mui/icons-material/Accessible";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TuneIcon from "@mui/icons-material/Tune";
import Badge from "@mui/material/Badge";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Popover from "@mui/material/Popover";
import Radio from "@mui/material/Radio";
import type { SxProps, Theme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import type { OpeningHoursFilter } from "@openmapx/core";
import {
  AD_HOC_CATEGORY_ID,
  brandOptions,
  facetsForCategory,
  cuisineOptions as getCuisineOptions,
  HOURS_FILTER_CATEGORY_IDS,
  removeFilterPredicate,
  useBrandLogos,
  useCategoryFacetStore,
  useCategorySearchStore,
  useDataSourceStore,
  useExploreResults,
  useNlpSearchStore,
  useOpeningHoursStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { BRAND } from "@/lib/theme";
import { BrandLogo } from "./BrandLogo";
import { CategoryFiltersPanel } from "./CategoryFiltersPanel";
import { floatingChipSx, floatingToolbarSx } from "./floatingChipSx";
import { NlpUnmappedNotice } from "./NlpFilterChips";

/** Chip row cap — most common brands first, everything past this stays reachable by narrowing the map/search instead. */
const MAX_BRAND_CHIPS = 6;

// Recognized OSM attribute keys (base form). A small model sometimes echoes
// these into `unmapped_attributes` instead of leaving them out — they aren't
// genuinely "unmapped", so they're stripped from the notice.
const KNOWN_OSM_ATTRIBUTE_KEYS = new Set([
  "outdoor_seating",
  "wheelchair",
  "internet_access",
  "cuisine",
  "diet",
  "takeaway",
  "delivery",
  "drive_through",
  "smoking",
  "dog",
  "fee",
  "payment",
  "live_music",
  "organic",
  "distance",
]);

// Display order: Mon–Sun; JS day indices
const DAYS: { key: string; idx: number }[] = [
  { key: "monday", idx: 1 },
  { key: "tuesday", idx: 2 },
  { key: "wednesday", idx: 3 },
  { key: "thursday", idx: 4 },
  { key: "friday", idx: 5 },
  { key: "saturday", idx: 6 },
  { key: "sunday", idx: 0 },
];

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function chipLabel(
  filter: OpeningHoursFilter,
  openAtDay: number | null,
  openAtHour: number | null,
  t: (key: string) => string,
): string {
  if (filter === "open_now") return t("openNow");
  if (filter === "open_24h") return t("open24h");
  if (filter === "open_at") {
    const d = openAtDay !== null ? DAY_SHORT[openAtDay] : null;
    const h = openAtHour !== null ? `${String(openAtHour).padStart(2, "0")}:00` : null;
    if (d && h) return `${d} · ${h}`;
    if (d) return d;
    if (h) return h;
  }
  return t("openingTimes");
}

const HOUR_OPTIONS: { value: number | null }[] = [
  { value: null },
  ...Array.from({ length: 24 }, (_, h) => ({ value: h })),
];

// Shared styling for the standalone toggle chips (fuel "Open now",
// wheelchair). The opening-times chip reuses the same look since it also
// carries a dropdown affordance.
const toggleChipSx = (active: boolean): SxProps<Theme> => floatingChipSx(active, "toggle");

function predicateChipLabel(
  pred: { key: string; op?: string; value?: string },
  exclude: boolean,
): string {
  if (exclude) {
    if (pred.op === "exists") return `no ${pred.key}`;
    return `${pred.key}≠${pred.value ?? ""}`;
  }
  if (pred.op === "exists") return pred.key;
  if (pred.op === "~") return `${pred.key}: ${pred.value ?? ""}`;
  return `${pred.key}=${pred.value ?? ""}`;
}

function PickerButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      sx={{
        width: "100%",
        px: 1.5,
        py: 0.75,
        border: "1px solid",
        borderColor: selected ? BRAND : "var(--omx-border)",
        borderRadius: "20px",
        bgcolor: selected ? "var(--omx-hover-bg)" : "transparent",
        color: selected ? BRAND : "text.primary",
        fontWeight: selected ? 600 : 400,
        fontSize: 13,
        cursor: "pointer",
        textAlign: "center",
        transition: "border-color 0.15s, background 0.15s",
        "&:hover": { borderColor: BRAND, bgcolor: "var(--omx-hover-bg)" },
      }}
    >
      {label}
    </Box>
  );
}

export function CategoryFilterBar() {
  const t = useTranslations("category");
  const tc = useTranslations("common");
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const { openingHoursFilter, openAtDay, openAtHour, setOpeningHoursFilter, setOpenAtFilter } =
    useOpeningHoursStore();
  const facetSelections = useCategoryFacetStore((s) => s.selections);
  const toggleFacet = useCategoryFacetStore((s) => s.toggleFacet);
  const setMultiFacet = useCategoryFacetStore((s) => s.setMultiFacet);
  const activeSource = useDataSourceStore((s) => s.activeSource);
  // NLP search: surface attributes that couldn't be mapped to a structured
  // filter (e.g. "best", "instagrammable") so the user knows they aren't
  // narrowing the results.
  const isNlpActive = useNlpSearchStore((s) => s.isNlpActive);
  const nlpRawUnmapped = useNlpSearchStore((s) => s.intent?.unmapped_attributes);
  const nlpIntentFilter = useNlpSearchStore((s) => s.intent?.filter);
  // Keep only genuine free-text qualities ("cozy", "best") — drop anything that
  // is a recognized OSM tag key or already appears as a key/value in the
  // structured filter predicates (small models duplicate/echo the tag vocabulary
  // into unmapped_attributes), and dedupe.
  const nlpUnmapped = useMemo(() => {
    if (!nlpRawUnmapped) return [];
    const mappedTerms = new Set<string>();
    for (const pred of [...(nlpIntentFilter?.require ?? []), ...(nlpIntentFilter?.exclude ?? [])]) {
      mappedTerms.add(pred.key);
      if (pred.value) mappedTerms.add(pred.value);
    }
    return [
      ...new Set(
        nlpRawUnmapped.filter((a) => !mappedTerms.has(a) && !KNOWN_OSM_ATTRIBUTE_KEYS.has(a)),
      ),
    ];
  }, [nlpRawUnmapped, nlpIntentFilter]);
  const unmappedNotice =
    isNlpActive && nlpUnmapped.length > 0 ? <NlpUnmappedNotice attributes={nlpUnmapped} /> : null;

  const adHocFilter = useCategorySearchStore((s) => s.adHocFilter);
  const adHocLabel = useCategorySearchStore((s) => s.adHocLabel);
  const setAdHocFilter = useCategorySearchStore((s) => s.setAdHocFilter);
  const isAdHocMode = activeCategory === AD_HOC_CATEGORY_ID;

  const { rawResults, dominantCategory } = useExploreResults();
  // In text mode there is no active category chip — reuse the facets of the
  // category that the results predominantly belong to (e.g. "McDonald's" →
  // restaurants), so a text search shows the same filters as that category.
  const effectiveCategory = activeCategory ?? dominantCategory;

  const panelFacets = useMemo(
    () => facetsForCategory(effectiveCategory).filter((f) => f.placement === "panel"),
    [effectiveCategory],
  );
  const cuisineOpts = useMemo(() => getCuisineOptions(rawResults ?? []), [rawResults]);
  const activePanelCount = panelFacets.filter(
    (f) => (facetSelections[f.id]?.length ?? 0) > 0,
  ).length;
  const wheelchairOn = (facetSelections.wheelchairAccessible?.length ?? 0) > 0;

  // Brand facet: a group-by over results already in the client, so it's
  // offered under every category rather than gated by `facetsForCategory`.
  // A single brand narrows nothing, so the row only renders at 2+.
  const brandOpts = useMemo(() => brandOptions(rawResults ?? []), [rawResults]);
  const topBrandOpts = useMemo(() => brandOpts.slice(0, MAX_BRAND_CHIPS), [brandOpts]);
  const brandLogos = useBrandLogos(useMemo(() => topBrandOpts.map((b) => b.qid), [topBrandOpts]));
  const selectedBrandQids = facetSelections.brand ?? [];
  const showBrandChips = brandOpts.length >= 2;
  const toggleBrand = (qid: string) =>
    setMultiFacet(
      "brand",
      selectedBrandQids.includes(qid)
        ? selectedBrandQids.filter((v) => v !== qid)
        : [...selectedBrandQids, qid],
    );
  const brandChips = showBrandChips
    ? topBrandOpts.map((b) => {
        const selected = selectedBrandQids.includes(b.qid);
        return (
          <Chip
            key={b.qid}
            icon={
              <BrandLogo
                brand={{
                  qid: b.qid,
                  name: b.name,
                  logoFile: brandLogos.get(b.qid),
                  kind: ["brand"],
                }}
                size={16}
              />
            }
            label={`${b.name} · ${b.count}`}
            onClick={() => toggleBrand(b.qid)}
            variant={selected ? "filled" : "outlined"}
            sx={toggleChipSx(selected)}
          />
        );
      })
    : null;

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [panelAnchorEl, setPanelAnchorEl] = useState<HTMLElement | null>(null);
  // Pending state — committed only on Apply
  const [pendingMode, setPendingMode] = useState<OpeningHoursFilter>(openingHoursFilter);
  const [pendingDay, setPendingDay] = useState<number | null>(openAtDay);
  const [pendingHour, setPendingHour] = useState<number | null>(openAtHour);

  // Fuel stations (data source): simple "Open now" toggle chip. No brand
  // chips here — selecting a data source calls clearCategory() first, so
  // rawResults (and therefore brandOpts) is always empty for this branch.
  if (activeSource === "fuel") {
    const isFiltered = openingHoursFilter === "open_now";
    return (
      <Box sx={{ ...floatingToolbarSx, gap: 1, flexWrap: "wrap", pointerEvents: "none" }}>
        <Chip
          icon={
            <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
              <AccessTimeIcon sx={{ fontSize: 16 }} />
            </Box>
          }
          label={t("openNow")}
          onClick={() => setOpeningHoursFilter(isFiltered ? "any" : "open_now")}
          variant={isFiltered ? "filled" : "outlined"}
          sx={toggleChipSx(isFiltered)}
        />
      </Box>
    );
  }

  // Ad-hoc filter mode: show predicate chips (require + exclude) as removable
  // chips so the user can refine the NLP-generated query. Normal facet controls
  // (wheelchair, panel filters) are hidden — they don't apply to ad-hoc QL.
  if (isAdHocMode && adHocFilter) {
    const requireChips = (adHocFilter.require ?? []).map((pred, i) => (
      <Chip
        key={`require-${pred.key}-${pred.value ?? ""}`}
        label={predicateChipLabel(pred, false)}
        onDelete={() =>
          setAdHocFilter(removeFilterPredicate(adHocFilter, "require", i), adHocLabel ?? "")
        }
        variant="filled"
        sx={floatingChipSx(true, "toggle")}
      />
    ));
    const excludeChips = (adHocFilter.exclude ?? []).map((pred, i) => (
      <Chip
        key={`exclude-${pred.key}-${pred.value ?? ""}`}
        label={predicateChipLabel(pred, true)}
        onDelete={() =>
          setAdHocFilter(removeFilterPredicate(adHocFilter, "exclude", i), adHocLabel ?? "")
        }
        variant="filled"
        sx={floatingChipSx(true, "toggle")}
      />
    ));
    // Brand chips are deliberately omitted here: ad-hoc mode's results are
    // already narrowed server-side by the Overpass QL, but
    // useFilteredCategoryResults only re-applies the hours filter for ad-hoc
    // results, not facets (facet narrowing already happened). Rendering the
    // chip would flip it to "filled" on click without actually filtering
    // anything, and applying facets here would double-filter.
    const hasChips = requireChips.length > 0 || excludeChips.length > 0;
    if (!hasChips && !unmappedNotice) return null;
    return (
      <Box sx={{ ...floatingToolbarSx, gap: 1, flexWrap: "wrap", pointerEvents: "none" }}>
        {requireChips}
        {excludeChips}
        {unmappedNotice && <Box sx={{ flexBasis: "100%" }}>{unmappedNotice}</Box>}
      </Box>
    );
  }

  // No opening-times toolbar for this category, but the brand chips (any
  // category) or an NLP unmapped-attributes notice may still apply.
  if (!effectiveCategory || !HOURS_FILTER_CATEGORY_IDS.has(effectiveCategory)) {
    if (!unmappedNotice && !showBrandChips) return null;
    return (
      <Box sx={{ ...floatingToolbarSx, gap: 1, flexWrap: "wrap", pointerEvents: "none" }}>
        {brandChips}
        {unmappedNotice && <Box sx={{ flexBasis: "100%" }}>{unmappedNotice}</Box>}
      </Box>
    );
  }

  const isFiltered = openingHoursFilter !== "any";
  const label = chipLabel(openingHoursFilter, openAtDay, openAtHour, t);

  const handleApply = () => {
    if (pendingMode === "open_at") {
      setOpenAtFilter(pendingDay, pendingHour);
    } else {
      setOpeningHoursFilter(pendingMode);
    }
    setAnchorEl(null);
  };

  const handleClear = () => {
    setPendingMode("any");
    setPendingDay(null);
    setPendingHour(null);
    setOpeningHoursFilter("any");
    setAnchorEl(null);
  };

  const radioSx = { color: BRAND, "&.Mui-checked": { color: BRAND }, p: 0.5 };

  return (
    <Box sx={{ ...floatingToolbarSx, gap: 1, flexWrap: "wrap", pointerEvents: "none" }}>
      <Chip
        icon={
          <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
            <AccessTimeIcon sx={{ fontSize: 16 }} />
          </Box>
        }
        label={
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {label}
            <ExpandMoreIcon
              sx={{
                fontSize: 16,
                transition: "transform 0.15s",
                transform: anchorEl ? "rotate(180deg)" : "none",
              }}
            />
          </Box>
        }
        onClick={(e) => {
          setPendingMode(openingHoursFilter);
          setPendingDay(openAtDay);
          setPendingHour(openAtHour);
          setAnchorEl(e.currentTarget);
        }}
        variant={isFiltered ? "filled" : "outlined"}
        sx={toggleChipSx(isFiltered)}
      />
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        sx={{ mt: 0.5 }}
      >
        <Paper elevation={3} sx={{ width: 340, display: "flex", flexDirection: "column" }}>
          {/* Top radio group */}
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            {(
              [
                { value: "any", label: t("anyTime") },
                { value: "open_now", label: t("openNow") },
                { value: "open_24h", label: t("open24h") },
              ] as { value: OpeningHoursFilter; label: string }[]
            ).map((opt) => (
              <Box
                key={opt.value}
                component="label"
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  py: 0.75,
                  cursor: "pointer",
                }}
              >
                <Radio
                  checked={pendingMode === opt.value}
                  onChange={() => setPendingMode(opt.value)}
                  size="small"
                  sx={radioSx}
                />
                <Typography
                  variant="body2"
                  sx={{
                    fontSize: 15,
                  }}
                >
                  {opt.label}
                </Typography>
              </Box>
            ))}
          </Box>

          <Divider />

          {/* "Open at" option with day + time pickers */}
          <Box sx={{ px: 2, pt: 1, pb: 0.5 }}>
            <Box
              component="label"
              sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.75, cursor: "pointer" }}
            >
              <Radio
                checked={pendingMode === "open_at"}
                onChange={() => setPendingMode("open_at")}
                size="small"
                sx={radioSx}
              />
              <Typography
                variant="body2"
                sx={{
                  fontSize: 15,
                }}
              >
                {t("openAt")}
              </Typography>
            </Box>

            {/* Day + Time grid — always visible but dims when mode isn't open_at */}
            <Box
              sx={{
                display: "flex",
                gap: 1,
                mt: 1,
                mb: 1,
                opacity: pendingMode === "open_at" ? 1 : 0.35,
                pointerEvents: pendingMode === "open_at" ? "auto" : "none",
              }}
            >
              {/* Days column */}
              <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, width: 130 }}>
                {DAYS.map((d) => (
                  <PickerButton
                    key={d.idx}
                    label={t(d.key)}
                    selected={pendingDay === d.idx}
                    onClick={() => setPendingDay(pendingDay === d.idx ? null : d.idx)}
                  />
                ))}
              </Box>

              {/* Divider */}
              <Divider orientation="vertical" flexItem />

              {/* Time column — scrollable */}
              <Box
                sx={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  gap: 0.75,
                  maxHeight: 280,
                  overflowY: "auto",
                  pr: 0.5,
                  scrollbarWidth: "thin",
                }}
              >
                {HOUR_OPTIONS.map((h) => (
                  <PickerButton
                    key={h.value ?? "any"}
                    label={
                      h.value === null ? t("anyTime") : `${String(h.value).padStart(2, "0")}:00`
                    }
                    selected={pendingHour === h.value}
                    onClick={() => setPendingHour(pendingHour === h.value ? null : h.value)}
                  />
                ))}
              </Box>
            </Box>
          </Box>

          <Divider />

          {/* Footer */}
          <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 2, py: 1 }}>
            <Button
              variant="text"
              size="small"
              onClick={handleClear}
              sx={{ textTransform: "none", color: "text.secondary" }}
            >
              {tc("clear")}
            </Button>
            <Button
              variant="text"
              size="small"
              onClick={handleApply}
              sx={{ textTransform: "none", color: BRAND, fontWeight: 600 }}
            >
              {tc("apply")}
            </Button>
          </Box>
        </Paper>
      </Popover>
      <Chip
        icon={
          <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
            <AccessibleIcon sx={{ fontSize: 16 }} />
          </Box>
        }
        label={t("wheelchairAccessible")}
        onClick={() => toggleFacet("wheelchairAccessible")}
        variant={wheelchairOn ? "filled" : "outlined"}
        sx={toggleChipSx(wheelchairOn)}
      />
      {brandChips}
      {panelFacets.length > 0 && (
        <>
          <Chip
            icon={
              <Box sx={{ display: "flex", alignItems: "center", color: "inherit !important" }}>
                <TuneIcon sx={{ fontSize: 16 }} />
              </Box>
            }
            label={
              <Badge
                badgeContent={activePanelCount}
                color="primary"
                sx={{ "& .MuiBadge-badge": { right: -10, top: 2, bgcolor: BRAND } }}
              >
                {t("filters")}
              </Badge>
            }
            onClick={(e) => setPanelAnchorEl(e.currentTarget)}
            variant={activePanelCount > 0 ? "filled" : "outlined"}
            sx={toggleChipSx(activePanelCount > 0)}
          />
          <CategoryFiltersPanel
            anchorEl={panelAnchorEl}
            onClose={() => setPanelAnchorEl(null)}
            facets={panelFacets}
            cuisineOptions={cuisineOpts}
          />
        </>
      )}
      {/* Unmapped NLP attributes drop to their own line below the chip row. */}
      {unmappedNotice && <Box sx={{ flexBasis: "100%" }}>{unmappedNotice}</Box>}
    </Box>
  );
}
