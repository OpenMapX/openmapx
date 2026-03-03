"use client";

import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type { Place } from "@openmapx/core";

interface Props {
  place: Place;
  isLoading: boolean;
}

interface TagGroup {
  label: string;
  keys: readonly string[];
}

// Keys consumed by enrichment — shown elsewhere, not as raw OSM strings
const ENRICHMENT_KEYS = new Set(["wikidata", "wikipedia", "wikimedia_commons"]);

const TAG_GROUPS: TagGroup[] = [
  {
    label: "Accessibility",
    keys: ["wheelchair", "wheelchair:description", "tactile_paving", "kerb"],
  },
  {
    label: "Service options",
    keys: [
      "takeaway",
      "delivery",
      "drive_through",
      "outdoor_seating",
      "indoor_seating",
      "dog",
      "smoking",
    ],
  },
  {
    label: "Payment methods",
    keys: [
      "payment:cash",
      "payment:credit_cards",
      "payment:debit_cards",
      "payment:contactless",
      "payment:coins",
      "payment:notes",
      "payment:visa",
      "payment:mastercard",
    ],
  },
  {
    label: "Food and drink",
    keys: ["cuisine", "diet:vegan", "diet:vegetarian", "diet:halal", "diet:kosher"],
  },
  {
    label: "Internet",
    keys: ["internet_access", "internet_access:fee", "wifi"],
  },
  {
    label: "Recycling",
    keys: [
      "recycling:batteries",
      "recycling:cans",
      "recycling:glass",
      "recycling:paper",
      "recycling:plastic",
      "recycling:light_bulbs",
    ],
  },
];

/** Converts an OSM tag key into a human-readable label. */
function formatTagKey(key: string): string {
  return key
    .replace(/^[^:]+:/, (prefix) => `${prefix.slice(0, -1).replace(/_/g, " ")} · `)
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function TagItem({ tagKey, value }: { tagKey: string; value: string }) {
  const label = formatTagKey(tagKey);
  const isYes = value === "yes";
  const isNo = value === "no";

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mb: 0.5 }}>
      {isYes ? (
        <CheckIcon sx={{ fontSize: 16, color: "success.main", flexShrink: 0 }} />
      ) : isNo ? (
        <CloseIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
      ) : (
        <CheckIcon sx={{ fontSize: 16, color: "text.disabled", flexShrink: 0 }} />
      )}
      <Typography
        variant="body2"
        color={isNo ? "text.disabled" : "text.primary"}
        sx={{ wordBreak: "break-word" }}
      >
        {label}
        {!isYes && !isNo && (
          <Typography component="span" variant="body2" color="text.secondary">
            {" · "}
            {value}
          </Typography>
        )}
      </Typography>
    </Box>
  );
}

interface RenderedGroup {
  label: string;
  entries: Array<{ key: string; value: string }>;
}

function buildGroups(osmTags: Record<string, string>): RenderedGroup[] {
  const assigned = new Set<string>();
  const groups: RenderedGroup[] = [];

  for (const group of TAG_GROUPS) {
    const entries: Array<{ key: string; value: string }> = [];
    for (const key of group.keys) {
      const value = osmTags[key];
      if (value !== undefined) {
        entries.push({ key, value });
        assigned.add(key);
      }
    }
    if (entries.length > 0) {
      groups.push({ label: group.label, entries });
    }
  }

  // Catch-all for unassigned tags (excluding enrichment meta-keys)
  const other: Array<{ key: string; value: string }> = [];
  for (const [key, value] of Object.entries(osmTags)) {
    if (!assigned.has(key) && !ENRICHMENT_KEYS.has(key)) {
      other.push({ key, value });
    }
  }
  if (other.length > 0) {
    groups.push({ label: "Other details", entries: other });
  }

  return groups;
}

export function PlaceInfoTab({ place, isLoading }: Props) {
  const hasDescription = Boolean(place.description);
  const hasFacts = Boolean(place.facts?.length);
  const hasOsmTags = Boolean(place.osmTags && Object.keys(place.osmTags).length > 0);
  const hasAnyContent = hasDescription || hasFacts || hasOsmTags;

  if (isLoading && !hasAnyContent) {
    return (
      <Box sx={{ px: 2, pt: 2, pb: 2 }}>
        {[0, 1, 2].map((i) => (
          <Box key={i} sx={{ mb: 2.5 }}>
            <Skeleton variant="text" width="40%" height={20} sx={{ mb: 1 }} />
            <Skeleton variant="text" width="65%" />
            <Skeleton variant="text" width="55%" />
            <Skeleton variant="text" width="70%" />
          </Box>
        ))}
      </Box>
    );
  }

  if (!hasAnyContent) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          py: 4,
          px: 2,
          color: "text.secondary",
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 40, opacity: 0.35 }} />
        <Typography variant="body2" fontWeight={500}>
          No additional information available
        </Typography>
        <Typography variant="caption" align="center">
          OpenStreetMap has no extra attributes for this place.
        </Typography>
      </Box>
    );
  }

  const osmGroups = hasOsmTags ? buildGroups(place.osmTags as Record<string, string>) : [];
  const showDividerBeforeOsm = hasDescription || hasFacts;

  return (
    <Box sx={{ pb: 2 }}>
      {/* Description */}
      {hasDescription && (
        <Box sx={{ px: 2, pt: 2, pb: 1.5 }}>
          <Typography variant="body2" color="text.secondary">
            {place.description}
          </Typography>
        </Box>
      )}

      {/* Wikidata facts */}
      {hasFacts && (
        <>
          {hasDescription && <Divider />}
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2" fontWeight={600} gutterBottom>
              About this place
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                columnGap: 1,
              }}
            >
              {place.facts?.map(({ label, value }) => (
                <Box key={label} sx={{ display: "flex", flexDirection: "column", mb: 0.75 }}>
                  <Typography variant="caption" color="text.secondary">
                    {label}
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: "break-word" }}>
                    {value}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>
        </>
      )}

      {/* OSM attribute groups */}
      {osmGroups.map((group, idx) => (
        <Box key={group.label}>
          {(idx === 0 ? showDividerBeforeOsm : true) && <Divider />}
          <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
            <Typography variant="subtitle2" fontWeight={600} gutterBottom>
              {group.label}
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                columnGap: 1,
              }}
            >
              {group.entries.map(({ key, value }) => (
                <TagItem key={key} tagKey={key} value={value} />
              ))}
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
