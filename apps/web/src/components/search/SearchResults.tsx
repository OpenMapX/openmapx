"use client";

import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import type {
  AutocompleteResult,
  DistanceReference,
  LabeledPlace,
  SearchIntent,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import type { FocusEventHandler } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { SEARCH_BAR_CLEARANCE } from "@/lib/layout";
import { servedAttributions } from "@/lib/servedAttributions";
import { AutocompleteDropdown } from "./AutocompleteDropdown";
import { NlpSearchCard } from "./NlpSearchCard";
import { SearchEmptyState } from "./SearchEmptyState";

export interface SuggestionListProps {
  rows: AutocompleteResult[];
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (row: AutocompleteResult) => void;
  distanceReference: DistanceReference | null;
  query: string;
  idPrefix: string;
  /** The parsed natural-language search offered above the rows. */
  nlpCard: { intent: SearchIntent; providerLabel: string; onActivate: () => void } | null;
  /** Whether a submitted natural-language query is still being parsed. */
  nlpParsing: boolean;
}

export interface EmptySearchProps {
  onSelectPlace: (place: LabeledPlace) => void;
  onSelectRecent: (query: string) => void;
  onClearRecent: () => void;
}

interface SearchVisibilityInput {
  focused: boolean;
  nearbyMode: boolean;
  stopSearch: boolean;
  /** The typed text, trimmed. */
  query: string;
  rows: readonly AutocompleteResult[];
  fetching: boolean;
  syntheticResult: AutocompleteResult | null;
  nlpShowCard: boolean;
  nlpPending: boolean;
}

/** Which of the empty state, the suggestions, the AI card and the skeleton the bar shows. */
export function searchVisibility({
  focused,
  nearbyMode,
  stopSearch,
  query,
  rows,
  fetching,
  syntheticResult,
  nlpShowCard,
  nlpPending,
}: SearchVisibilityInput) {
  const showNlpCard = !nearbyMode && !stopSearch && nlpShowCard;
  // While the first results load, the area-search row alone would stand in
  // for a list; the loading skeleton shows instead until real rows arrive.
  const awaitingFirstRows = fetching && rows.every((row) => row.type === "text_search");
  const showSuggestions =
    focused && ((rows.length > 0 && !awaitingFirstRows) || showNlpCard || nlpPending);
  return {
    showNlpCard,
    showSuggestions,
    showEmpty: focused && !nearbyMode && query.length === 0,
    showSkeleton:
      !nearbyMode &&
      focused &&
      query.length >= 2 &&
      fetching &&
      !showSuggestions &&
      !syntheticResult,
  };
}

/** The parse row, the AI card, the ranked rows and the sources that served them. */
function SuggestionList({
  rows,
  highlightedIndex,
  onHighlight,
  onSelect,
  distanceReference,
  query,
  idPrefix,
  nlpCard,
  nlpParsing,
  creditsPy,
}: SuggestionListProps & { creditsPy: number }) {
  const t = useTranslations("search");
  const registry = useIntegrationRegistry();
  // Attribution follows the visible ranked rows, not the response envelope.
  const attributions = servedAttributions(registry, rows);
  return (
    <>
      {/* While a submitted NL query is parsing, a loading row gives feedback
          during the (slow) inference instead of a frozen-looking bar. */}
      {nlpParsing && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.5 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" sx={{ color: "text.secondary" }}>
            {t("aiUnderstanding")}
          </Typography>
        </Box>
      )}
      {nlpCard && (
        <NlpSearchCard
          intent={nlpCard.intent}
          providerLabel={nlpCard.providerLabel}
          onActivate={nlpCard.onActivate}
        />
      )}
      <AutocompleteDropdown
        suggestions={rows}
        onSelect={onSelect}
        highlightedIndex={highlightedIndex}
        onHighlight={onHighlight}
        distanceReference={distanceReference}
        query={query}
        idPrefix={idPrefix}
      />
      {attributions.length > 0 && (
        <Box sx={{ display: "flex", justifyContent: "center", px: 1, py: creditsPy }}>
          <AttributionStrip attributions={attributions} variant="inline" />
        </Box>
      )}
    </>
  );
}

/** Skeleton rows shown while the first results are loading. */
function SuggestionSkeleton() {
  return [0, 1, 2].map((i) => (
    <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}>
      <Skeleton variant="circular" width={20} height={20} />
      <Box sx={{ flex: 1 }}>
        <Skeleton variant="text" width="55%" height={16} />
        <Skeleton variant="text" width="35%" height={13} />
      </Box>
    </Box>
  ));
}

interface InlineSearchResultsProps {
  showEmpty: boolean;
  showSuggestions: boolean;
  showSkeleton: boolean;
  empty: EmptySearchProps;
  list: SuggestionListProps;
}

/** Results attached inside the bar's own card, below the input. */
export function InlineSearchResults({
  showEmpty,
  showSuggestions,
  showSkeleton,
  empty,
  list,
}: InlineSearchResultsProps) {
  return (
    <>
      {showEmpty && (
        <>
          <Divider />
          <Box sx={{ maxHeight: 320, overflowY: "auto" }}>
            <SearchEmptyState {...empty} />
          </Box>
        </>
      )}
      {showSuggestions && (
        <>
          <Divider />
          <Box sx={{ maxHeight: 320, flex: "none", minHeight: 0, overflowY: "auto" }}>
            <SuggestionList {...list} creditsPy={0.5} />
          </Box>
        </>
      )}
      {showSkeleton && (
        <>
          <Divider />
          <SuggestionSkeleton />
        </>
      )}
    </>
  );
}

interface FullScreenSearchResultsProps extends InlineSearchResultsProps {
  onFocusCapture: FocusEventHandler;
  onBlurCapture: FocusEventHandler;
}

/**
 * The phone's full-screen results panel, mounted while the bar is focused.
 * It sits on the white backdrop below the bar and fills the rest of the
 * viewport: saved places and recents for an empty query, otherwise the rows.
 */
export function FullScreenSearchResults({
  showEmpty,
  showSuggestions,
  showSkeleton,
  empty,
  list,
  onFocusCapture,
  onBlurCapture,
}: FullScreenSearchResultsProps) {
  const content = showEmpty ? (
    <SearchEmptyState {...empty} />
  ) : showSuggestions ? (
    <SuggestionList {...list} creditsPy={1} />
  ) : showSkeleton ? (
    <Box>
      <SuggestionSkeleton />
    </Box>
  ) : null;
  return (
    <Box
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
      sx={{
        position: "absolute",
        // Below the bar, which itself sits below the top safe area. Inside
        // the installed app the page draws under the status bar, so a
        // fixed offset would put the results over the search input.
        top: SEARCH_BAR_CLEARANCE,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 13,
        overflowY: "auto",
        bgcolor: "background.paper",
      }}
    >
      {content}
    </Box>
  );
}
