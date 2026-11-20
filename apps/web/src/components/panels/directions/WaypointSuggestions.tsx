"use client";

import Box from "@mui/material/Box";
import type { AutocompleteResult, LngLat } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { AutocompleteDropdown } from "@/components/search/AutocompleteDropdown";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { servedAttributions } from "@/lib/servedAttributions";

interface WaypointSuggestionsProps {
  suggestions: AutocompleteResult[];
  query: string;
  userLocation: LngLat | null;
  onSelect: (result: AutocompleteResult) => void;
}

/** The focused stop field's suggestions, credited to the sources that served them. */
export function WaypointSuggestions({
  suggestions,
  query,
  userLocation,
  onSelect,
}: WaypointSuggestionsProps) {
  const registry = useIntegrationRegistry();
  const attributions = servedAttributions(registry, suggestions);
  return (
    <Box
      sx={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bgcolor: "background.paper",
        zIndex: 2,
        boxShadow: "0 4px 12px var(--omx-shadow-soft)",
      }}
    >
      <AutocompleteDropdown
        suggestions={suggestions}
        onSelect={onSelect}
        query={query}
        distanceReference={
          userLocation ? { kind: "user_location", coordinates: userLocation } : undefined
        }
      />
      {attributions.length > 0 && (
        <Box sx={{ px: 2, py: 0.75 }}>
          <AttributionStrip attributions={attributions} variant="plain" />
        </Box>
      )}
    </Box>
  );
}
