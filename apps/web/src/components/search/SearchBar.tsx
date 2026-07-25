"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import MenuIcon from "@mui/icons-material/Menu";
import MicIcon from "@mui/icons-material/Mic";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import SearchIcon from "@mui/icons-material/Search";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { formatShortcut, getPlatform, parseShortcut } from "@openmapx/command-palette";
import type { AutocompleteResult, BoundingBox, CategoryId, LngLat } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  CATEGORY_DEFINITIONS,
  coordinateId,
  createPlace,
  decodeShortPlusCode,
  detectShortPlusCodeCity,
  idsFromPrimaryOrCoords,
  isTransitRawCategory,
  PANEL,
  parseCoordinateInput,
  parseDMSCoordinateInput,
  parsePlusCodeInput,
  resolveStopAsPlace,
  useActiveSidePanel,
  useAdaptiveDebounce,
  useAirportSearch,
  useAutocomplete,
  useCategorySearchStore,
  useChipTranslations,
  useCommandPaletteStore,
  useDataSourceStore,
  useDebounce,
  useDirectionsStore,
  useGeocoding,
  useLabeledPlaces,
  useMenuStore,
  useNlpSearch,
  useNlpSearchStore,
  usePlaceStore,
  usePresetSuggest,
  useSavedPlacesStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
  useStopSearch,
} from "@openmapx/core";
import { isPlausibleNlSearch } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountAvatarButton } from "@/components/auth/AccountAvatarButton";
import { SEARCH_INPUT_ID } from "@/components/command-palette/constants";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { NlpConsentDialog } from "@/components/ui/NlpConsentDialog";
import { hasNlpConsent, isNlpCloudDeclined, setNlpConsent } from "@/components/ui/nlpConsent";
import { attributionsForProviders } from "@/lib/attributionForProviders";
import {
  launchExploreFromPlace,
  launchExploreTextSearch,
  launchTextSearch,
} from "@/lib/launchExplore";
import { useMap } from "@/lib/MapContext";
import { isConfidentPlaceMatch } from "@/lib/placeMatch";
import { BRAND } from "@/lib/theme";
import { AutocompleteDropdown } from "./AutocompleteDropdown";
import { MobileSearchEmptyState } from "./MobileSearchEmptyState";
import { NlpSearchCard } from "./NlpSearchCard";

/** Pre-parsed once at module load — the shortcut never changes, no need to
 *  re-parse it on every SearchBar render. */
const PALETTE_SHORTCUT = parseShortcut("Mod+K");

/** Bigram set of a string. */
function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/** Sørensen–Dice coefficient (0..1). */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bg1 = bigrams(a);
  const bg2 = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of bg1) {
    intersection += Math.min(count, bg2.get(bg) ?? 0);
  }
  return (2 * intersection) / (a.length - 1 + (b.length - 1));
}

/** Score a search result against the query (higher = more relevant). */
function searchRelevance(result: AutocompleteResult, query: string): number {
  const q = query.toLowerCase();
  const label = result.label.toLowerCase();

  // Dice similarity on full strings
  let score = diceSimilarity(q, label);

  // Prefix bonus: label starts with query
  if (label.startsWith(q)) {
    score += 0.4;
  } else if (label.includes(q)) {
    // Substring bonus (weaker)
    score += 0.15;
  }

  // Check sublabel too (e.g. "Berlin" might appear in address sublabel)
  if (result.sublabel) {
    const sub = result.sublabel.toLowerCase();
    if (sub.includes(q)) score += 0.05;
  }

  // Labeled places (Home, Work, custom) get a strong boost to appear near the top
  if (result.type === "labeled_place") score += 0.5;

  return score;
}

const MODE_LABEL_KEYS: Record<string, string> = {
  bus: "bus",
  rail: "rail",
  subway: "subway",
  tram: "tram",
  ferry: "ferry",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
  walking: "walking",
};

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Browser SpeechRecognition constructor, if available (incl. the webkit prefix). */
function getSpeechRecognition(): SpeechRecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/**
 * Resolve a region-qualified BCP-47 tag for recognition. Android's speech
 * service rejects region-less tags (next-intl exposes `"en"`/`"de"`) with a
 * `language-not-supported` error, so prefer the device's own fully-qualified
 * language when it matches the app locale, then fall back to a default region.
 */
function speechLang(locale: string): string {
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  if (nav.includes("-") && nav.split("-")[0].toLowerCase() === locale.toLowerCase()) {
    return nav;
  }
  const fallback: Record<string, string> = { en: "en-US", de: "de-DE" };
  return fallback[locale] ?? locale;
}

/**
 * Map a Web Speech API error code (`SpeechRecognitionErrorEvent.error`, or a
 * `start()` exception) to a translation key under the `search` namespace, so a
 * failed dictation shows an actionable message instead of failing silently.
 */
function voiceErrorKey(code: string | undefined): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "voiceErrorNotAllowed";
    case "audio-capture":
      return "voiceErrorNoMicrophone";
    case "network":
      return "voiceErrorNetwork";
    case "language-not-supported":
      return "voiceErrorLanguage";
    case "no-speech":
      return "voiceErrorNoSpeech";
    default:
      return "voiceErrorGeneric";
  }
}

export function SearchBar() {
  const t = useTranslations("search");
  const tModes = useTranslations("searchModes");
  const tSaved = useTranslations("saved");
  const tCmd = useTranslations("commandPalette");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const { query, isFocused, suggestions, setQuery, setIsFocused, setSuggestions, setResults } =
    useSearchStore();
  const { setSelectedPlace } = usePlaceStore();
  const { isOpen: hasSidePanel, close: closeSidePanel } = useActiveSidePanel();
  const { isOpen: directionsOpen, open: openDirections } = useDirectionsStore();
  const { activeCategory, setActiveCategory, clearCategory } = useCategorySearchStore();
  const anchor = useCategorySearchStore((s) => s.anchor);
  const exploreBoxOpen = useCategorySearchStore((s) => s.exploreBoxOpen);
  // Nearby/Explore mode: a place is the anchor. Reuses this search bar, adding a
  // brand-coloured pill and routing selections to the place-anchored category search.
  const nearbyMode = anchor !== null;
  const activeSource = useDataSourceStore((s) => s.activeSource);
  const setActiveSource = useDataSourceStore((s) => s.setActiveSource);
  const openMenu = useMenuStore((s) => s.open);
  const { selectedListId, clearSelectedList } = useSavedPlacesStore();
  const { flyTo, mapRef } = useMap();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [shortcutPlatform, setShortcutPlatform] = useState<ReturnType<typeof getPlatform>>("other");
  const debouncedQuery = useAdaptiveDebounce(query, 150, 50);
  const debouncedGeoQuery = useDebounce(query, 400);
  const { data: autocompleteData, isFetching } = useAutocomplete(debouncedQuery, locale);
  const { data: geocodeData } = useGeocoding(debouncedGeoQuery, locale);
  const { data: presetData } = usePresetSuggest(debouncedQuery, locale);
  const { data: airportSearchData } = useAirportSearch(debouncedQuery, 5);
  const { data: chipTranslations = {} } = useChipTranslations(locale);

  // NLP search fires on submit whenever the query does NOT resolve to a
  // confident place match (see handleSubmit). No keyword classifier — the
  // geocode-confidence gate decides navigate-vs-search, language-agnostically.
  // Snapshot the current viewport for the parse request. These are cheap ref
  // reads; the hook's query key rounds the center so tiny pans don't refetch.
  const mapCenterRaw = mapRef.current?.getCenter();
  const mapCenter: LngLat | null = mapCenterRaw ? [mapCenterRaw.lng, mapCenterRaw.lat] : null;
  const mapBoundsRaw = mapRef.current?.getBounds();
  const mapBbox: BoundingBox | null = mapBoundsRaw
    ? {
        west: mapBoundsRaw.getWest(),
        south: mapBoundsRaw.getSouth(),
        east: mapBoundsRaw.getEast(),
        north: mapBoundsRaw.getNorth(),
      }
    : null;

  // Cloud consent gating: when the user has declined cloud providers, re-issue
  // the parse with noCloud:true so the server falls back to local/keyword.
  // Lazy init from localStorage so a returning decliner never triggers a cloud
  // call or the consent dialog on subsequent sessions.
  const [nlpNoCloud, setNlpNoCloud] = useState(() => isNlpCloudDeclined());
  // consentGranted tracks local acceptance within this session so the card
  // renders immediately after the user clicks "Enable" without a re-fetch.
  const [consentGranted, setConsentGranted] = useState(false);
  // The natural-language parse is expensive on this deployment (~10-20s CPU
  // inference), so it fires only when the user submits (Enter / search button),
  // never per keystroke. Any edit to the query resets this (see handleChange).
  const [nlpSubmitted, setNlpSubmitted] = useState(false);

  // Voice search (Web Speech API). Feature-detected — the mic button only
  // renders when the browser exposes SpeechRecognition. Dictation fills the
  // input and, on a final result, runs through the normal submit path.
  // Resolved in an effect (not during render) so the first client render matches
  // the server, which has no `window`: rendering the mic button at hydration
  // time would otherwise diverge from the SSR markup (hydration mismatch). The
  // button appears immediately after mount.
  const [speechCtor, setSpeechCtor] = useState<SpeechRecognitionCtor | undefined>(undefined);
  useEffect(() => {
    // Updater form: the value we store IS a function (the constructor), which
    // React would otherwise treat as a state updater and invoke (throws — the
    // ctor needs `new`).
    setSpeechCtor(() => getSpeechRecognition());
  }, []);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [voicePendingSubmit, setVoicePendingSubmit] = useState(false);
  // Surfaced when dictation fails (permission blocked, no network, etc.) so the
  // mic button reports the reason instead of silently doing nothing.
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const startVoiceSearch = useCallback(() => {
    if (!speechCtor) return;
    setVoiceError(null);

    const beginRecognition = () => {
      recognitionRef.current?.abort();
      const rec = new speechCtor();
      rec.lang = speechLang(locale);
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0]?.transcript ?? "";
        }
        transcript = transcript.trim();
        if (!transcript) return;
        setNlpSubmitted(false);
        setQuery(transcript);
        if (event.results[event.results.length - 1]?.isFinal) setVoicePendingSubmit(true);
      };
      rec.onerror = (event) => {
        setListening(false);
        console.warn("[voice-search] recognition error:", event.error);
        setVoiceError(t(voiceErrorKey(event.error)));
      };
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      try {
        rec.start();
      } catch (err) {
        setListening(false);
        console.warn("[voice-search] start() threw:", err);
        setVoiceError(t(voiceErrorKey(undefined)));
      }
    };

    setListening(true);

    // SpeechRecognition's own microphone-permission flow is broken in installed
    // PWAs on Android: start() fails with `not-allowed` and never shows a prompt
    // even when the origin could be granted. getUserMedia *does* reliably raise
    // the prompt and grant the origin mic access, so request (and immediately
    // release) it first, then start recognition. Falls straight through where
    // mediaDevices is unavailable (older browsers, SSR, tests).
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!media?.getUserMedia) {
      beginRecognition();
      return;
    }
    media
      .getUserMedia({ audio: true })
      .then((stream) => {
        // Release the mic immediately so recognition can capture it.
        for (const track of stream.getTracks()) track.stop();
        beginRecognition();
      })
      .catch((err: unknown) => {
        setListening(false);
        const name = err instanceof DOMException ? err.name : undefined;
        console.warn("[voice-search] mic permission error:", name);
        setVoiceError(t(voiceErrorKey(name === "NotFoundError" ? "audio-capture" : "not-allowed")));
      });
  }, [speechCtor, locale, setQuery, t]);

  const toggleVoiceSearch = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
    } else {
      startVoiceSearch();
    }
  }, [listening, startVoiceSearch]);

  // Once the final transcript has flushed into the query, run the existing
  // submit path so voice and typed queries behave identically.
  useEffect(() => {
    if (!voicePendingSubmit) return;
    setVoicePendingSubmit(false);
    inputRef.current?.form?.requestSubmit();
  }, [voicePendingSubmit]);

  // Stop recognition if the component unmounts mid-listen.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  // The natural-language parse is opt-out: when AI search is disabled in
  // Settings the parse never fires, so search falls back to plain autocomplete.
  const aiSearchEnabled = useSettingsStore((s) => s.aiSearchEnabled);

  const { data: nlpData, isFetching: nlpFetching } = useNlpSearch(
    debouncedQuery,
    mapCenter,
    mapBbox,
    nlpSubmitted && aiSearchEnabled,
    locale,
    nlpNoCloud,
  );

  // Stop search — slower debounce to reduce transit API load
  const rawStopQuery = query.trim().length >= 2 ? query.trim() : "";
  const debouncedStopQuery = useDebounce(rawStopQuery, 750);
  const { data: stopSearchData } = useStopSearch(debouncedStopQuery);

  // Labeled places (Home, Work, custom) for search suggestions
  const { data: labeledPlaces } = useLabeledPlaces();

  // Data source categories from integration manifests
  const registry = useIntegrationRegistry();
  const dataSourceCategories = useMemo(() => {
    const withSearchCat = registry.getWithSearchCategory();
    return withSearchCat
      .map((i) => {
        const sc = i.frontend?.searchCategory as
          | { id: string; label?: string; iconPath?: string }
          | undefined;
        if (!sc) return null;
        return { id: sc.id, label: sc.label ?? sc.id, iconPath: sc.iconPath, integrationId: i.id };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [registry]);

  // Clean up blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) clearTimeout(blurTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    setShortcutPlatform(getPlatform());
  }, []);

  // Entering nearby mode (clicked "Nearby" on a place): clear the query and
  // focus so the category picker dropdown opens in the reused search bar.
  useEffect(() => {
    if (exploreBoxOpen) {
      setQuery("");
      setIsFocused(true);
      inputRef.current?.focus();
    }
  }, [exploreBoxOpen, setQuery, setIsFocused]);

  const handleBlur = useCallback(() => {
    blurTimeoutRef.current = setTimeout(() => setIsFocused(false), 150);
  }, [setIsFocused]);

  // When user types a short plus code with city, geocode the city name to get
  // the reference coordinates for decoding.
  const shortPlusCity = detectShortPlusCodeCity(query.trim());
  const debouncedCity = useDebounce(shortPlusCity?.city ?? "", 400);
  const { data: cityRefData } = useGeocoding(debouncedCity, locale);

  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      queryClient.removeQueries({ queryKey: ["autocomplete"] });
    } else {
      setSuggestions(autocompleteData ?? []);
    }
    setHighlightedIndex(-1);
  }, [autocompleteData, query, queryClient, setSuggestions]);

  useEffect(() => {
    setResults(geocodeData ?? []);
  }, [geocodeData, setResults]);

  // Detect coordinate / plus-code input and create a synthetic suggestion
  const q = query.trim();
  let syntheticResult: AutocompleteResult | null = null;
  if (q.length >= 2) {
    let parsed = parseCoordinateInput(q) ?? parseDMSCoordinateInput(q);

    if (!parsed) {
      // Short plus code with city: use geocoded city coordinates as reference
      if (shortPlusCity && cityRefData?.[0]) {
        const lngLat = decodeShortPlusCode(shortPlusCity.code, cityRefData[0].coordinates);
        if (lngLat) parsed = { lngLat, label: `${shortPlusCity.code} ${shortPlusCity.city}` };
      }

      // Full plus code or short code without city: use map center as reference
      if (!parsed) {
        const raw = mapRef.current?.getCenter();
        const mapCenter: LngLat | undefined = raw ? [raw.lng, raw.lat] : undefined;
        parsed = parsePlusCodeInput(q, mapCenter);
      }
    }

    if (parsed) {
      syntheticResult = {
        id: `coordinate:${coordinateId(parsed.lngLat)}`,
        label: parsed.label,
        coordinates: parsed.lngLat,
        type: "address",
      };
    }
  }

  // Inject matching category suggestions at the top of the dropdown
  // Merges POI categories (hardcoded) with data source categories (from manifests)
  const categorySuggestions = useMemo<AutocompleteResult[]>(() => {
    if (q.length < 1) return [];
    const lower = q.toLowerCase();
    const lowerNormalized = lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const poiMatches = CATEGORY_DEFINITIONS.filter((cat) => {
      if (cat.label.toLowerCase().includes(lower)) return true;
      const tr = chipTranslations[cat.id];
      if (!tr) return false;
      if (
        tr.name
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .includes(lowerNormalized)
      ) {
        return true;
      }
      return tr.terms.some((term) => term.includes(lowerNormalized));
    }).map((cat) => ({
      id: `category-${cat.id}`,
      label: chipTranslations[cat.id]?.name ?? cat.label,
      sublabel: t("searchCategory"),
      type: "category" as const,
      iconPath: cat.iconPath,
    }));
    const dsMatches = dataSourceCategories
      .filter((ds) => ds.label.toLowerCase().includes(lower))
      .map((ds) => ({
        id: `category-${ds.id}`,
        label: ds.label,
        sublabel: t("searchCategory"),
        type: "category" as const,
        iconPath: ds.iconPath,
      }));
    return [...dsMatches, ...poiMatches];
  }, [q, t, dataSourceCategories, chipTranslations]);

  const presetSuggestions = useMemo<AutocompleteResult[]>(() => {
    return (presetData?.matches ?? []).map((p) => ({
      id: `category-preset:${p.id}`,
      label: p.name,
      sublabel: t("searchCategory"),
      type: "category" as const,
      presetIconKey: p.iconKey,
    }));
  }, [presetData, t]);

  // Airports — match the IATA / ICAO / name index loaded by knowledge-ourairports.
  // Surfaces results like "DUS — Düsseldorf Airport" alongside the geocoder.
  // Uses the `oa:` place-resolver scheme so selection drives straight to the
  // airport's full place panel (runways / frequencies / navaids) instead of a
  // coordinate-based reverse-geocode that may land on a building inside the
  // airport polygon.
  const airportSuggestions = useMemo<AutocompleteResult[]>(() => {
    return (airportSearchData?.matches ?? []).map((a) => {
      const codeBadge = a.iata ?? a.icao ?? a.ident;
      const labelPrefix = codeBadge ? `${codeBadge} — ` : "";
      const cityCountry = [a.municipality, a.isoCountry].filter(Boolean).join(", ");
      return {
        id: `oa:${a.ident}`,
        label: `${labelPrefix}${a.name}`,
        sublabel: cityCountry,
        coordinates: [a.lng, a.lat],
        type: "poi" as const,
        rawCategory: "aeroway/aerodrome",
        presetIconKey: "maki-airport",
      };
    });
  }, [airportSearchData]);

  const stopSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (stopSearchData ?? []).map(
        (stop): AutocompleteResult => ({
          id: `stop-${stop.id}`,
          label: stop.name,
          sublabel: stop.modes
            .map((m) => (MODE_LABEL_KEYS[m] ? tModes(MODE_LABEL_KEYS[m]) : m))
            .join(", "),
          coordinates: [stop.lng, stop.lat],
          type: "transit_stop",
          transitStop: stop,
        }),
      ),
    [stopSearchData, tModes],
  );

  // Labeled places — match against translated label name, place name, and address
  const labeledSuggestions = useMemo<AutocompleteResult[]>(
    () =>
      (labeledPlaces ?? [])
        .filter((lp) => {
          if (q.length === 0) return false;
          const ql = q.toLowerCase();
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? tSaved(lp.label) : lp.label;
          return (
            translatedLabel.toLowerCase().includes(ql) ||
            lp.name.toLowerCase().includes(ql) ||
            (lp.address?.toLowerCase().includes(ql) ?? false)
          );
        })
        .map((lp): AutocompleteResult => {
          const translatedLabel =
            lp.label === "home" || lp.label === "work" ? tSaved(lp.label) : lp.label;
          return {
            id: `labeled-${lp.id}`,
            label: translatedLabel,
            sublabel: lp.name + (lp.address ? ` — ${lp.address}` : ""),
            coordinates: [lp.lng, lp.lat],
            type: "labeled_place",
            labelKey: lp.label,
          };
        }),
    [q, labeledPlaces, tSaved],
  );

  const displaySuggestions = useMemo(() => {
    // Client-side narrowing: keep items where every query token appears
    // somewhere in label or sublabel. Substring-only matching dropped real
    // hits like "Frankfurt am Main Airport ..." for the query "Frankfurt
    // Airport" because the tokens weren't contiguous.
    const narrowResults = (items: AutocompleteResult[]): AutocompleteResult[] => {
      if (q.length < 2 || items.length === 0) return items;
      const tokens = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      if (tokens.length === 0) return items;
      const filtered = items.filter((s) => {
        const hay = `${s.label} ${s.sublabel ?? ""}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
      return filtered.length > 0 ? filtered : items;
    };

    return (
      syntheticResult
        ? [syntheticResult]
        : [
            ...labeledSuggestions,
            ...categorySuggestions,
            ...presetSuggestions,
            ...airportSuggestions,
            ...narrowResults(suggestions),
            ...narrowResults(stopSuggestions).slice(0, 3),
          ].sort((a, b) => searchRelevance(b, q) - searchRelevance(a, q))
    ).filter(
      (s, i, arr) =>
        arr.findIndex((x) => {
          if (x.label !== s.label || (x.sublabel ?? "") !== (s.sublabel ?? "")) return false;
          if (!x.coordinates || !s.coordinates) return x.id === s.id;
          const dlng = x.coordinates[0] - s.coordinates[0];
          const dlat = x.coordinates[1] - s.coordinates[1];
          return dlng * dlng + dlat * dlat < 0.0001; // ~1 km
        }) === i,
    );
  }, [
    q,
    syntheticResult,
    labeledSuggestions,
    categorySuggestions,
    presetSuggestions,
    airportSuggestions,
    suggestions,
    stopSuggestions,
  ]);

  // Nearby mode: the dropdown shows category suggestions (+ a free-text item)
  // anchored to the place, mirroring the old ExploreSearchBox picker.
  const nearbySuggestions = useMemo<AutocompleteResult[]>(() => {
    if (!nearbyMode) return [];
    const lower = q.toLowerCase();
    const cats = CATEGORY_DEFINITIONS.filter(
      (cat) => cat.showInChipBar && (q === "" || cat.label.toLowerCase().includes(lower)),
    ).map((cat) => ({
      id: `nearby-cat-${cat.id}`,
      label: cat.label,
      type: "category" as const,
      iconPath: cat.iconPath,
      rawCategory: cat.id,
    }));
    if (q === "") return cats;
    return [
      { id: "nearby-freetext", label: t("searchFreeText", { query: q }), type: "poi" as const },
      ...cats,
    ];
  }, [nearbyMode, q, t]);

  if (directionsOpen) return null;

  const handleActivateNlp = () => {
    if (!nlpData) return;
    const { intent, resolvedBbox, provider } = nlpData;
    if (intent.filter.selectors.length === 0) return;
    useNlpSearchStore.getState().activate(intent, resolvedBbox, provider);
    useCategorySearchStore.getState().setAdHocFilter(intent.filter, intent.explanation);
    useCategorySearchStore.getState().setSearchBbox(resolvedBbox);
    useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
    setIsFocused(false);
    inputRef.current?.blur();
  };

  const effectiveSuggestions = nearbyMode ? nearbySuggestions : displaySuggestions;
  // Credit only the geocoder(s) that actually produced the suggestions on
  // screen. Each geocoded item carries its serving integration id
  // (AutocompleteResult.provider, tagged by the geocoding orchestrator);
  // category / NLP / labeled / preset suggestions have none, so a dropdown
  // without geocoded results shows no geocoder credit — rather than the old
  // behaviour of crediting every healthy geocoder regardless of who served.
  // Plain const (not a hook): this sits below an early return, and the lookup
  // is a handful of registry reads that <AttributionStrip> dedupes downstream.
  const geocodingAttributions = attributionsForProviders(
    registry,
    new Set(effectiveSuggestions.map((s) => s.provider)),
  );
  // The NLP card is additive and only shown for plausible natural-language
  // intents (confidence + at least one category). It never replaces the
  // parallel geocode/autocomplete suggestions below it.
  const nlpIntent = nlpData?.intent;
  const nlpProvider = nlpData?.provider;
  const isCloudProvider = nlpProvider === "claude" || nlpProvider === "openai";
  // Cloud consent: suppress the card if the result came from a cloud provider
  // and the user has not yet consented (either via localStorage or this session).
  const storedConsent = hasNlpConsent();
  const consentOk = !isCloudProvider || consentGranted || storedConsent;
  const showNlpCard =
    !nearbyMode && nlpIntent !== undefined && isPlausibleNlSearch(nlpIntent) && consentOk;
  const showConsentDialog =
    !nearbyMode &&
    nlpIntent !== undefined &&
    isPlausibleNlSearch(nlpIntent) &&
    isCloudProvider &&
    !consentGranted &&
    !storedConsent;
  const nlpCard =
    showNlpCard && nlpData ? (
      <NlpSearchCard
        intent={nlpData.intent}
        provider={nlpData.provider}
        onActivate={handleActivateNlp}
      />
    ) : null;
  // While a submitted NL query is parsing, show a loading row so the user gets
  // feedback during the (slow) inference instead of a frozen-looking bar.
  const nlpPending = nlpSubmitted && nlpFetching && !nlpData;
  const nlpLoadingCard = nlpPending ? (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.5 }}>
      <CircularProgress size={18} />
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("aiUnderstanding")}
      </Typography>
    </Box>
  ) : null;
  const showDropdown = isFocused && (effectiveSuggestions.length > 0 || showNlpCard || nlpPending);

  const tryOpenTransitStop = async (coords: LngLat, name: string): Promise<boolean> => {
    try {
      const delta = 0.005; // ~500m
      const stops = await apiClient.get<TransitStop[]>(API_ENDPOINTS.transitStops, {
        sw_lat: String(coords[1] - delta),
        sw_lng: String(coords[0] - delta),
        ne_lat: String(coords[1] + delta),
        ne_lng: String(coords[0] + delta),
      });
      // Require every query token to appear as a token in the stop name and
      // then pick the closest one. The previous 10-char-prefix substring
      // match was far too loose — it routed "Frankfurt Airport" to a random
      // stop containing "Frankfurt " (e.g. "Frankfurt am Main, Tor 31").
      const queryTokens = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
      const match = queryTokens.length
        ? stops
            .filter((s) => {
              const stopTokens = s.name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? ([] as string[]);
              return queryTokens.every((t) => stopTokens.includes(t));
            })
            .sort(
              (a, b) =>
                (a.lng - coords[0]) ** 2 +
                (a.lat - coords[1]) ** 2 -
                ((b.lng - coords[0]) ** 2 + (b.lat - coords[1]) ** 2),
            )[0]
        : undefined;
      if (match) {
        // Reuse the shared synthetic-stop builder so the Place picks up
        // the provider-scoped scheme (tfl, mb, dyn, …) from the stop id.
        void resolveStopAsPlace(match).then((place) => {
          setSelectedPlace(place);
          useSidebarStore.getState().openSidebar(PANEL.PLACE);
        });
        return true;
      }
    } catch {
      // Silently fall back to place panel
    }
    return false;
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showDropdown) return;
    const count = displaySuggestions.length;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev < count - 1 ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : count - 1));
    } else if (e.key === "Enter" && highlightedIndex >= 0) {
      e.preventDefault();
      handleSelectAny(effectiveSuggestions[highlightedIndex]);
    } else if (e.key === "Escape") {
      setIsFocused(false);
      setHighlightedIndex(-1);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    // In nearby mode keep the anchor (don't clearCategory — that would drop it);
    // the nearby dropdown re-filters and a selection relaunches the search.
    if (!nearbyMode) {
      // If user modifies the query while a category/data source is active, clear it
      if (activeCategory !== null) {
        clearCategory();
      }
      if (activeSource !== null) {
        setActiveSource(null);
      }
    }
    // Editing the query invalidates any pending/previous NL parse — it must be
    // re-submitted to fire again (keeps the slow parse off the keystroke path).
    if (nlpSubmitted) setNlpSubmitted(false);
    setQuery(newValue);
  };

  const handleSubmit = (e: React.FormEvent) => {
    // AuthDialog is portaled from the mobile account avatar inside this form.
    // React portal events follow the component tree, so its inner form's submit
    // reaches this handler unless we limit search handling to this form itself.
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    if (nearbyMode) {
      inputRef.current?.blur();
      if (anchor && q.length > 0) launchExploreTextSearch(mapRef.current, anchor, q);
      return;
    }
    if (syntheticResult) {
      inputRef.current?.blur();
      handleSelect(syntheticResult);
      return;
    }
    // Navigate straight to a place ONLY when the top geocode result confidently
    // matches the query (its label covers most of what was typed) and is a
    // precise location or transit stop. A low-relevance match (e.g. "Glen Park,
    // Indiana" for "Park mit See in Aachen") must NOT teleport the user — it
    // falls through to the NL parse below instead.
    const first = geocodeData?.[0];
    if (first) {
      const isTransit = Boolean(first.rawCategory && isTransitRawCategory(first.rawCategory));
      const isPreciseType = first.type !== "poi" || isTransit;
      if (isPreciseType && isConfidentPlaceMatch(query.trim(), first)) {
        inputRef.current?.blur();
        // Area results (cities/regions/countries) are framed by PlaceBoundaryLayer,
        // which fits the map to the admin boundary — flying to a fixed zoom first
        // would just cause a zoom-in-then-out jump.
        if (first.type !== "region") flyTo(first.coordinates, 15);
        const firstPlace = createPlace({
          ...idsFromPrimaryOrCoords(first.id, first.coordinates),
          name: first.label,
          address: first.label,
          coordinates: first.coordinates,
          category: first.type,
          rawCategory: first.rawCategory,
        });
        if (isTransit) {
          void tryOpenTransitStop(first.coordinates, first.label).then((found) => {
            if (!found) {
              setSelectedPlace(firstPlace);
              useSidebarStore.getState().openSidebar(PANEL.PLACE);
            }
          });
        } else {
          setSelectedPlace(firstPlace);
          useSidebarStore.getState().openSidebar(PANEL.PLACE);
        }
        return;
      }
    }
    // Not a confident place match → run the NL parse and keep the dropdown open
    // (place candidates + AI card) so the user disambiguates. Never auto-navigate
    // to a low-relevance geocode result.
    if (mapCenter && mapBbox) {
      setNlpSubmitted(true);
      setIsFocused(true);
      return;
    }
    // No viewport available yet (rare) → viewport free-text search floor.
    inputRef.current?.blur();
    if (q.trim().length > 0) {
      launchTextSearch(mapRef.current, q);
    }
  };

  const handleSelect = (result: AutocompleteResult) => {
    if (result.type === "labeled_place" && result.coordinates) {
      setQuery(result.label);
      setIsFocused(false);
      flyTo(result.coordinates, 15);
      setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords(result.id, result.coordinates),
          name: result.sublabel?.split(" — ")[0] ?? result.label,
          address: result.sublabel?.split(" — ")[1] ?? result.sublabel ?? result.label,
          coordinates: result.coordinates,
        }),
      );
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
      return;
    }

    if (result.type === "transit_stop" && result.transitStop) {
      setQuery(result.label);
      setIsFocused(false);
      if (result.coordinates) flyTo(result.coordinates, 15);
      void resolveStopAsPlace(result.transitStop).then((place) => {
        setSelectedPlace(place);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      });
      return;
    }

    if (result.type === "category") {
      // Extract category id from the synthetic id ("category-restaurants" → "restaurants")
      const catId = result.id.replace("category-", "");
      const dsMatch = dataSourceCategories.find((ds) => ds.id === catId);
      if (dsMatch) {
        // Route to data source system (manifest-driven)
        clearCategory();
        setActiveSource(dsMatch.id);
        useSidebarStore.getState().openSidebar(PANEL.DATASOURCE);
      } else {
        setActiveCategory(catId as Parameters<typeof setActiveCategory>[0]);
        useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
      }
      setQuery(result.label);
      setIsFocused(false);
      return;
    }

    setQuery(result.label);
    setIsFocused(false);
    if (result.coordinates) {
      const coords = result.coordinates;
      // Area results are framed by PlaceBoundaryLayer (fit to admin boundary);
      // skip the fixed-zoom fly to avoid a zoom-in-then-out jump.
      if (result.type !== "region") flyTo(coords, 15);
      const suggestionPlace = createPlace({
        ...idsFromPrimaryOrCoords(result.id, coords),
        name: result.label,
        address: result.sublabel ?? result.label,
        coordinates: coords,
        category: result.type,
        rawCategory: result.rawCategory,
      });
      // Route to a transit-stop lookup only when the geocoder itself classified
      // the result as transit infrastructure — never on a label-keyword match.
      if (result.rawCategory && isTransitRawCategory(result.rawCategory)) {
        void tryOpenTransitStop(coords, result.label).then((found) => {
          if (!found) {
            setSelectedPlace(suggestionPlace);
            useSidebarStore.getState().openSidebar(PANEL.PLACE);
          }
        });
      } else {
        setSelectedPlace(suggestionPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      }
    }
  };

  // Nearby mode: route a category pick / free-text to the place-anchored search.
  const handleNearbySelect = (result: AutocompleteResult) => {
    if (!anchor) return;
    setIsFocused(false);
    inputRef.current?.blur();
    if (result.id === "nearby-freetext") {
      if (q.length > 0) launchExploreTextSearch(mapRef.current, anchor, q);
      return;
    }
    const catId = result.rawCategory as CategoryId | undefined;
    if (catId) launchExploreFromPlace(mapRef.current, anchor, catId, result.label);
  };

  const handleSelectAny = (result: AutocompleteResult) => {
    if (nearbyMode) handleNearbySelect(result);
    else handleSelect(result);
  };

  // Cancel nearby search (the brand pill's ✕): exit nearby mode and reopen the
  // place the search was started from.
  const handleCancelNearby = () => {
    const place = anchor;
    clearCategory();
    setQuery("");
    setIsFocused(false);
    if (place) {
      setSelectedPlace(place);
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    }
  };

  const showSkeleton =
    !nearbyMode &&
    isFocused &&
    query.trim().length >= 2 &&
    isFetching &&
    !showDropdown &&
    !syntheticResult;

  // Mobile: when the search is focused, the bar takes over the full viewport
  // Pure CSS transition — same component,same focus/dropdown state,
  // just a different layout.
  const fullScreen = isMobile && isFocused;

  const handleBack = () => {
    setIsFocused(false);
    inputRef.current?.blur();
  };

  return (
    <>
      {showConsentDialog && nlpProvider && (
        <NlpConsentDialog
          open
          provider={nlpProvider}
          onAccept={() => {
            setNlpConsent(true);
            setConsentGranted(true);
          }}
          onDecline={() => {
            setNlpConsent(false);
            setNlpNoCloud(true);
          }}
        />
      )}
      {/* Full-screen backdrop on mobile while the search is focused — the
          bar and results panel float on this white surface, hiding the map
          and bottom sheet underneath. */}
      {fullScreen && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            bgcolor: "background.paper",
            zIndex: 12,
          }}
        />
      )}
      <Box
        sx={{
          position: "absolute",
          top: "calc(12px + var(--omx-safe-top))",
          left: "calc(12px + var(--omx-safe-left))",
          right: {
            xs: "calc(12px + var(--omx-safe-right))",
            sm: "auto",
          },
          // Above CategoryChips (z-index 10) so the dropdown covers the chip
          // band on mobile when the user is typing — the chips stay rendered
          // (cheap, ready when search is dismissed) but visually hidden. In
          // fullscreen the bar sits above the white backdrop (z 12).
          zIndex: fullScreen ? 13 : 11,
          width: { xs: "auto", sm: "auto" },
        }}
      >
        <Paper
          elevation={fullScreen ? 0 : isFocused ? 4 : 2}
          sx={{
            width: { xs: "100%", sm: 376 },
            borderRadius: !fullScreen && showDropdown ? "24px 24px 16px 16px" : "24px",
            overflow: "hidden",
            transition: "box-shadow 0.2s, border-radius 0.15s, background-color 0.15s",
            // Bar turns into a light grey pill while focused,
            // signalling the active state without changing
            // its size or position.
            bgcolor: fullScreen ? "action.hover" : "background.paper",
          }}
        >
          {/* Search input row */}
          <Box
            component="form"
            onSubmit={handleSubmit}
            sx={{
              display: "flex",
              alignItems: "center",
              height: 48,
              px: 0.5,
              // The app-wide MuiIconButton override sets borderRadius: 8 (a
              // rounded square) which clashes with the pill-shaped search bar.
              // Force circular hover/focus halos for icons inside the bar so
              // they feel native to its rounded geometry.
              "& .MuiIconButton-root": { borderRadius: "50%" },
            }}
          >
            {fullScreen ? (
              <IconButton
                size="small"
                sx={{ ml: 0.5, mr: 0.5 }}
                onClick={handleBack}
                aria-label={tCommon("back")}
              >
                <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : selectedListId ? (
              <IconButton size="small" sx={{ ml: 0.5, mr: 0.5 }} onClick={clearSelectedList}>
                <ArrowBackIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : (
              <IconButton
                size="small"
                sx={{ ml: 0.5, mr: 0.5 }}
                onClick={openMenu}
                aria-label={t("menuAriaLabel")}
              >
                <MenuIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            )}

            <InputBase
              inputRef={inputRef}
              value={query}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsFocused(true)}
              onBlur={handleBlur}
              placeholder={
                nearbyMode && anchor
                  ? t("searchNearbyName", { name: anchor.name })
                  : t("placeholder")
              }
              inputProps={{ id: SEARCH_INPUT_ID, "aria-label": t("ariaLabel") }}
              sx={{
                flex: 1,
                fontSize: 16,
                "& input": {
                  padding: 0,
                  paddingLeft: "8px",
                  "&::placeholder": { color: "text.secondary", opacity: 1 },
                },
              }}
            />

            {speechCtor && (
              <IconButton
                size="small"
                onClick={toggleVoiceSearch}
                onMouseDown={(e) => e.preventDefault()}
                aria-label={t("voiceSearchAriaLabel")}
              >
                <MicIcon
                  sx={{ fontSize: 22, color: listening ? "error.main" : "text.secondary" }}
                />
              </IconButton>
            )}

            <Snackbar
              open={voiceError !== null}
              autoHideDuration={6000}
              onClose={() => setVoiceError(null)}
              anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
            >
              <Alert
                severity="warning"
                variant="filled"
                onClose={() => setVoiceError(null)}
                sx={{ width: "100%" }}
              >
                {voiceError}
              </Alert>
            </Snackbar>

            {fullScreen && query.length > 0 ? (
              <IconButton
                size="small"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                aria-label={tCommon("clear")}
              >
                <HighlightOffIcon sx={{ fontSize: 22, color: "text.secondary" }} />
              </IconButton>
            ) : (
              !fullScreen && (
                <IconButton
                  type="submit"
                  size="small"
                  aria-label={t("searchAriaLabel")}
                  // Don't let the button steal focus from the input — otherwise
                  // the blur handler collapses the suggestions/AI card on click,
                  // unlike pressing Enter (which keeps focus). The click still submits.
                  onMouseDown={(e) => e.preventDefault()}
                  sx={{ display: { xs: "none", sm: "inline-flex" } }}
                >
                  <SearchIcon sx={{ fontSize: 22, color: "text.secondary" }} />
                </IconButton>
              )
            )}

            {!nearbyMode && (
              <Tooltip title={tCmd("open")} placement="bottom">
                <Box
                  component="kbd"
                  role="button"
                  tabIndex={0}
                  aria-label={tCmd("open")}
                  onClick={() => useCommandPaletteStore.getState().open()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      useCommandPaletteStore.getState().open();
                    }
                  }}
                  sx={(theme) => ({
                    display: { xs: "none", sm: "inline-flex" },
                    alignItems: "center",
                    fontFamily: "monospace",
                    fontSize: 11,
                    px: 0.75,
                    py: 0.25,
                    ml: 0.5,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1,
                    color: "text.secondary",
                    cursor: "pointer",
                    userSelect: "none",
                    "&:hover": { bgcolor: "action.hover" },
                    "&:focus-visible": {
                      outline: `2px solid ${theme.palette.primary.main}`,
                      outlineOffset: 1,
                    },
                  })}
                >
                  {formatShortcut(PALETTE_SHORTCUT, shortcutPlatform)}
                </Box>
              </Tooltip>
            )}

            {!fullScreen &&
              !nearbyMode &&
              (hasSidePanel ? (
                <IconButton
                  size="small"
                  aria-label={t("closePanelAriaLabel")}
                  sx={{ ml: 1, mr: 0.5 }}
                  onClick={() => {
                    closeSidePanel();
                    setQuery("");
                  }}
                >
                  <CloseIcon sx={{ fontSize: 22, color: "text.secondary" }} />
                </IconButton>
              ) : (
                <Tooltip title={t("directionsTooltip")} placement="bottom">
                  <IconButton
                    size="small"
                    aria-label={t("getDirectionsAriaLabel")}
                    sx={{ ml: 1, mr: 0.5 }}
                    onClick={() => {
                      openDirections();
                      useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
                    }}
                  >
                    <DirectionsIcon sx={{ fontSize: 22, color: BRAND }} />
                  </IconButton>
                </Tooltip>
              ))}
            {/* Account avatar — inline in the search bar on mobile.
              The desktop equivalent is a separate floating control
              rendered by TopRightControls. Hidden when the search
              has expanded to fullscreen — it's not relevant
              while the user is typing a query. */}
            {!fullScreen && !nearbyMode && (
              <Box sx={{ display: { xs: "inline-flex", sm: "none" }, ml: 0.25, mr: 0.25 }}>
                <AccountAvatarButton size={32} />
              </Box>
            )}

            {/* Nearby pill — replaces the right-side controls while a place is
                anchored. The ✕ cancels the nearby search and reopens the place. */}
            {!fullScreen && nearbyMode && (
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  bgcolor: BRAND,
                  color: "#fff",
                  borderRadius: 999,
                  ml: 1,
                  mr: 0.5,
                  pl: 1,
                  pr: 0.25,
                  height: 32,
                  flexShrink: 0,
                }}
              >
                <MyLocationIcon sx={{ fontSize: 18 }} />
                <Divider
                  orientation="vertical"
                  flexItem
                  sx={{ borderColor: "rgba(255,255,255,0.4)", mx: 0.5, my: 0.75 }}
                />
                <Tooltip title={t("cancelNearby")} placement="bottom">
                  <IconButton
                    size="small"
                    onClick={handleCancelNearby}
                    aria-label={t("cancelNearby")}
                    sx={{
                      color: "#fff",
                      p: 0.25,
                      "&:hover": { bgcolor: "rgba(255,255,255,0.15)" },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            )}
          </Box>

          {/* Suggestions list — directly attached inside the same card.
            Skipped on mobile-fullscreen, where the dropdown is rendered as
            a full-width sibling panel below the bar (see end of return). */}
          {!fullScreen && showDropdown && (
            <>
              <Divider />
              <Box
                sx={{
                  maxHeight: fullScreen ? "none" : 320,
                  flex: fullScreen ? 1 : "none",
                  minHeight: 0,
                  overflowY: "auto",
                }}
              >
                {nlpLoadingCard}
                {nlpCard}
                <AutocompleteDropdown
                  suggestions={effectiveSuggestions}
                  onSelect={handleSelectAny}
                  highlightedIndex={highlightedIndex}
                />
                {geocodingAttributions.length > 0 && (
                  <Box sx={{ display: "flex", justifyContent: "center", px: 1, py: 0.5 }}>
                    <AttributionStrip attributions={geocodingAttributions} variant="inline" />
                  </Box>
                )}
              </Box>
            </>
          )}

          {/* Skeleton rows shown while the first results are loading */}
          {!fullScreen && showSkeleton && (
            <>
              <Divider />
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}
                >
                  <Skeleton variant="circular" width={20} height={20} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton variant="text" width="55%" height={16} />
                    <Skeleton variant="text" width="35%" height={13} />
                  </Box>
                </Box>
              ))}
            </>
          )}
        </Paper>
      </Box>
      {/* Fullscreen results panel — only mounted on mobile while the bar
        is focused. Sits on top of the white backdrop, below the bar (with
        a small breathing gap), and fills the rest of the viewport. Empty
        query → labeled places; otherwise → autocomplete dropdown. */}
      {fullScreen && (
        <Box
          sx={{
            position: "absolute",
            top: 72,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 13,
            overflowY: "auto",
            bgcolor: "background.paper",
          }}
        >
          {query.trim().length === 0 && !nearbyMode ? (
            <MobileSearchEmptyState
              onSelectPlace={(p) => {
                setQuery(p.label);
                setIsFocused(false);
                flyTo([p.lng, p.lat], 15);
                setSelectedPlace(
                  createPlace({
                    ...idsFromPrimaryOrCoords(p.placeId ?? p.id, [p.lng, p.lat]),
                    name: p.name,
                    address: p.address ?? p.name,
                    coordinates: [p.lng, p.lat],
                  }),
                );
                useSidebarStore.getState().openSidebar(PANEL.PLACE);
              }}
            />
          ) : showDropdown ? (
            <>
              {nlpLoadingCard}
              {nlpCard}
              <AutocompleteDropdown
                suggestions={effectiveSuggestions}
                onSelect={handleSelectAny}
                highlightedIndex={highlightedIndex}
              />
              {geocodingAttributions.length > 0 && (
                <Box sx={{ display: "flex", justifyContent: "center", px: 1, py: 1 }}>
                  <AttributionStrip attributions={geocodingAttributions} variant="inline" />
                </Box>
              )}
            </>
          ) : showSkeleton ? (
            <Box>
              {[0, 1, 2].map((i) => (
                <Box
                  key={i}
                  sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2, py: 1.25 }}
                >
                  <Skeleton variant="circular" width={20} height={20} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton variant="text" width="55%" height={16} />
                    <Skeleton variant="text" width="35%" height={13} />
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      )}
    </>
  );
}
