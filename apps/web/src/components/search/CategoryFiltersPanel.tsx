"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import type { CategoryFacet } from "@openmapx/core";
import { useCategoryFacetStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";

function prettifyCuisine(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface Props {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  /** Panel-placement facets applicable to the active category. */
  facets: CategoryFacet[];
  /** Distinct cuisine values present in the current results (for the cuisine facet). */
  cuisineOptions: string[];
}

export function CategoryFiltersPanel({ anchorEl, onClose, facets, cuisineOptions }: Props) {
  const t = useTranslations("category");
  const tc = useTranslations("common");
  const selections = useCategoryFacetStore((s) => s.selections);
  const toggleFacet = useCategoryFacetStore((s) => s.toggleFacet);
  const setMultiFacet = useCategoryFacetStore((s) => s.setMultiFacet);
  const clearFacets = useCategoryFacetStore((s) => s.clearFacets);

  const toggleFacets = facets.filter((f) => f.type === "toggle");
  const ungroupedToggles = toggleFacets.filter((f) => !f.group);
  const groupedToggles = toggleFacets.filter((f) => f.group);
  const groupOrder = [...new Set(groupedToggles.map((f) => f.group as string))];
  const cuisineFacet = facets.find((f) => f.id === "cuisine");
  const selectedCuisines = cuisineFacet ? (selections.cuisine ?? []) : [];
  // Show the cuisines present in the current results plus any still-selected
  // ones, so a selection stays visible (and removable) after panning away.
  const displayedCuisines = [...new Set([...cuisineOptions, ...selectedCuisines])].sort();

  const toggleCuisine = (value: string) => {
    const next = selectedCuisines.includes(value)
      ? selectedCuisines.filter((v) => v !== value)
      : [...selectedCuisines, value];
    setMultiFacet("cuisine", next);
  };

  const renderToggle = (facet: CategoryFacet) => (
    <FormControlLabel
      key={facet.id}
      control={
        <Checkbox
          checked={(selections[facet.id]?.length ?? 0) > 0}
          onChange={() => toggleFacet(facet.id)}
          size="small"
          sx={{ color: TEAL, "&.Mui-checked": { color: TEAL }, py: 0.5 }}
        />
      }
      label={<Typography variant="body2">{t(facet.id)}</Typography>}
      sx={{ ml: -0.5, mr: 0 }}
    />
  );

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: "top", horizontal: "left" }}
      sx={{ mt: 0.5 }}
    >
      <Paper elevation={3} sx={{ width: 320, display: "flex", flexDirection: "column" }}>
        {ungroupedToggles.length > 0 && (
          <Box sx={{ px: 2, pt: 1.5, pb: 1, display: "flex", flexDirection: "column" }}>
            {ungroupedToggles.map(renderToggle)}
          </Box>
        )}

        {groupOrder.map((group) => (
          <Box key={group}>
            <Divider />
            <Box sx={{ px: 2, pt: 1.25, pb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
                {t(group)}
              </Typography>
              <Box sx={{ display: "flex", flexDirection: "column" }}>
                {groupedToggles.filter((f) => f.group === group).map(renderToggle)}
              </Box>
            </Box>
          </Box>
        ))}

        {cuisineFacet && displayedCuisines.length > 0 && (
          <>
            <Divider />
            <Box sx={{ px: 2, pt: 1.25, pb: 1 }}>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                {t("cuisine")}
              </Typography>
              <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75 }}>
                {displayedCuisines.map((value) => {
                  const selected = selectedCuisines.includes(value);
                  return (
                    <Chip
                      key={value}
                      label={prettifyCuisine(value)}
                      size="small"
                      onClick={() => toggleCuisine(value)}
                      variant={selected ? "filled" : "outlined"}
                      sx={{
                        fontSize: 12,
                        bgcolor: selected ? TEAL : "transparent",
                        color: selected ? "#fff" : "text.primary",
                        borderColor: selected ? TEAL : "var(--omx-border)",
                        "&&:hover": { bgcolor: selected ? "var(--omx-teal-hover)" : "grey.200" },
                      }}
                    />
                  );
                })}
              </Box>
            </Box>
          </>
        )}

        <Divider />
        <Box sx={{ display: "flex", justifyContent: "flex-end", gap: 1, px: 2, py: 1 }}>
          <Button
            variant="text"
            size="small"
            onClick={() => clearFacets(facets.map((f) => f.id))}
            sx={{ textTransform: "none", color: "text.secondary" }}
          >
            {tc("clear")}
          </Button>
          <Button
            variant="text"
            size="small"
            onClick={onClose}
            sx={{ textTransform: "none", color: TEAL, fontWeight: 600 }}
          >
            {tc("done")}
          </Button>
        </Box>
      </Paper>
    </Popover>
  );
}
