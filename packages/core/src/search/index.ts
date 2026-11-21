export {
  geocodeStopAsPlace,
  makeSyntheticStopPlace,
  resolveStopAsPlace,
} from "./geocodeStopAsPlace";
export { type MatchRange, matchRanges } from "./matchRanges";
export {
  type DistanceReference,
  resolveDistanceReference,
  resultDistanceMetres,
  validResultCoordinates,
} from "./resultReference";
export {
  compareSearchSuggestions,
  editDistance,
  isRailwayStationCategory,
  isUppercaseAcronymIntent,
  localityScore,
  MIN_NEAR_SPELLING_LENGTH,
  MIN_SUGGESTION_TEXT_SCORE,
  mergeAutocompleteSuggestions,
  nearSpellingEdits,
  normalizeSearchTerm,
  type SuggestionScoreContext,
  suggestionScore,
  textMatchScore,
} from "./searchSuggestion";
export { sortResultsByIntent } from "./sortResults";
export {
  type AutocompleteCandidates,
  type AutocompleteRowLimits,
  brandSuggestionRows,
  DEFAULT_AUTOCOMPLETE_ROW_LIMITS,
  type EnterAction,
  enterAction,
  isPlausibleDestination,
  matchCategorySuggestions,
  matchRecentSearches,
  presetSuggestionRows,
  rankAutocompleteRows,
} from "./suggestionRanking";
