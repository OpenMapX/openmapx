import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useAutocompleteMock = vi.fn();
const useGeocodingMock = vi.fn();
const useNlpSearchMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useAutocomplete: (...a: unknown[]) => useAutocompleteMock(...a),
    useGeocoding: (...a: unknown[]) => useGeocodingMock(...a),
    useNlpSearch: (...a: unknown[]) => useNlpSearchMock(...a),
    usePresetSuggest: () => ({ data: undefined }),
    useAirportSearch: () => ({ data: undefined }),
    useChipTranslations: () => ({ data: {} }),
    useStopSearch: () => ({ data: undefined }),
    useLabeledPlaces: () => ({ data: undefined }),
  };
});

const fakeMap = createFakeMap();
const flyToMock = vi.fn();
vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fakeMap.map },
    mapReady: true,
    styleVersion: 0,
    flyTo: flyToMock,
    fitBounds: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetBearing: vi.fn(),
    notifyMapReady: vi.fn(),
    notifyStyleReload: vi.fn(),
  }),
}));

vi.mock("@/components/auth/AccountAvatarButton", async () => {
  const { createPortal } = await import("react-dom");
  return {
    AccountAvatarButton: () =>
      createPortal(
        <form onSubmit={(e) => e.preventDefault()}>
          <button type="submit">complete auth</button>
        </form>,
        document.body,
      ),
  };
});

const launchExploreFromPlace = vi.fn();
const launchExploreTextSearch = vi.fn();
const launchTextSearch = vi.fn();
vi.mock("@/lib/launchExplore", () => ({
  launchExploreFromPlace: (...a: unknown[]) => launchExploreFromPlace(...a),
  launchExploreTextSearch: (...a: unknown[]) => launchExploreTextSearch(...a),
  launchTextSearch: (...a: unknown[]) => launchTextSearch(...a),
}));

import type { AutocompleteResult, Place } from "@openmapx/core";
import {
  PANEL,
  useCategorySearchStore,
  useDirectionsStore,
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import { SearchBar } from "./SearchBar";

beforeEach(() => {
  useAutocompleteMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useGeocodingMock.mockReset().mockReturnValue({ data: [] });
  useNlpSearchMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  flyToMock.mockReset();
  launchExploreFromPlace.mockReset();
  launchExploreTextSearch.mockReset();
  launchTextSearch.mockReset();
  useSearchStore.getState().reset();
  useDirectionsStore.getState().close(); // SearchBar returns null while directions open
  useCategorySearchStore.setState({ anchor: null, exploreBoxOpen: false, activeCategory: null });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null });
  useSettingsStore.setState({ aiSearchEnabled: true });
});

const renderBar = () => render(<SearchBar />, { wrapper: createQueryWrapper() });

describe("SearchBar", () => {
  it("mounts and renders the search input", () => {
    renderBar();
    screen.getByLabelText("search.ariaLabel");
  });

  it("does not treat an auth-dialog submit as a search submit", () => {
    renderBar();

    // AuthDialog is portaled out of the search bar in the DOM, but React portal
    // events bubble through their component ancestors. The search form must
    // ignore a submit whose target is the dialog's inner form.
    fireEvent.click(screen.getByRole("button", { name: "complete auth" }));

    expect(useSearchStore.getState().isFocused).toBe(false);
  });

  it("surfaces a message when voice recognition errors instead of failing silently", async () => {
    // Held in a ref object rather than a bare `let`: the instance is captured
    // inside the constructor closure below, and TS's flow analysis mis-narrows
    // a closure-assigned `let` (to `null`/`never`) at the read sites — an
    // object property keeps its declared union type.
    const recRef: {
      current: {
        lang: string;
        start: ReturnType<typeof vi.fn>;
        onerror: ((e: { error: string }) => void) | null;
      } | null;
    } = { current: null };
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        recRef.current = this;
      }
    }
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    try {
      renderBar();
      // The mic button only renders after the mount effect feature-detects the API.
      const micButton = await screen.findByLabelText("search.voiceSearchAriaLabel");
      fireEvent.click(micButton);
      expect(recRef.current).not.toBeNull();
      expect(recRef.current?.start).toHaveBeenCalled();
      // Recognition must use a region-qualified tag, not the bare app locale.
      expect(recRef.current?.lang).toContain("-");

      // The browser rejects mic access: previously swallowed, now surfaced.
      act(() => recRef.current?.onerror?.({ error: "not-allowed" }));
      await screen.findByText("search.voiceErrorNotAllowed");
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
    }
  });

  it("requests the microphone via getUserMedia before starting recognition", async () => {
    // SpeechRecognition's own permission flow is broken in installed PWAs; the
    // mic is requested via getUserMedia first (which raises the prompt), then
    // the acquired track is released so recognition can capture it.
    const recRef: { current: { start: ReturnType<typeof vi.fn> } | null } = { current: null };
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
      constructor() {
        recRef.current = this;
      }
    }
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    try {
      renderBar();
      const micButton = await screen.findByLabelText("search.voiceSearchAriaLabel");
      fireEvent.click(micButton);
      await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({ audio: true }));
      await waitFor(() => expect(recRef.current?.start).toHaveBeenCalled());
      expect(stopTrack).toHaveBeenCalled();
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it("shows the mic-blocked message when getUserMedia permission is denied", async () => {
    class FakeRecognition {
      lang = "";
      continuous = false;
      interimResults = false;
      maxAlternatives = 1;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();
    }
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition =
      FakeRecognition;
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });
    try {
      renderBar();
      const micButton = await screen.findByLabelText("search.voiceSearchAriaLabel");
      fireEvent.click(micButton);
      await screen.findByText("search.voiceErrorMicBlocked");
    } finally {
      delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
  });

  it("dispatches a debounced autocomplete query on typing (fresh text: 150ms)", async () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.change(input, { target: { value: "berlin" } });

    // Debounce hasn't fired yet — only the empty-input mount call has landed.
    expect(useAutocompleteMock).not.toHaveBeenCalledWith("berlin", "en");

    // Real timers (not `vi.useFakeTimers`/`advanceTimersByTime`): this repo's
    // local `vitest.d.ts` type shim (apps/web/src/vitest.d.ts) does not declare
    // the timer-control APIs, so the 150ms debounce is awaited for real here.
    await waitFor(() => {
      const lastCall = useAutocompleteMock.mock.calls.at(-1);
      expect(lastCall).toEqual(["berlin", "en"]);
    });
  });

  it("renders dropdown results and commits a selection via ArrowDown + Enter", async () => {
    const suggestion: AutocompleteResult = {
      id: "osm:n1",
      label: "Berlin Hbf",
      sublabel: "Berlin, Germany",
      type: "poi",
      coordinates: [13.369, 52.525],
    };
    useAutocompleteMock.mockReturnValue({ data: [suggestion], isFetching: false });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin hbf" } });

    await screen.findByText("Berlin Hbf");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(flyToMock).toHaveBeenCalledWith([13.369, 52.525], 15);
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Berlin Hbf");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useSearchStore.getState().query).toBe("Berlin Hbf");
    expect(useSearchStore.getState().isFocused).toBe(false);
  });

  it("submitting a natural-language query enables NLP parsing; activating the card writes the NLP stores", async () => {
    // No confident geocode match → submit falls through to the NLP branch.
    useGeocodingMock.mockReturnValue({ data: [] });
    const intent = {
      filter: { selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }] },
      spatial_constraint: null,
      time_constraint: null,
      sort_by: "relevance" as const,
      unmapped_attributes: [],
      confidence: 0.9,
      explanation: "Cafés with WiFi",
    };
    useNlpSearchMock.mockReturnValue({
      data: { intent, resolvedBbox: null, provider: "local" },
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "cozy cafes with wifi" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    // 4th positional arg is the enabled flag (nlpSubmitted && aiSearchEnabled).
    expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true);

    await screen.findByText("Cafés with WiFi");

    fireEvent.click(screen.getByText("Cafés with WiFi"));

    expect(useNlpSearchStore.getState().isNlpActive).toBe(true);
    expect(useNlpSearchStore.getState().provider).toBe("local");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
  });

  it("shows no dropdown and keeps suggestions empty when the query is short", () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);

    expect(screen.queryByText("search.searchCategory")).toBeNull();
    expect(useSearchStore.getState().suggestions).toEqual([]);
  });

  it("silently swallows an autocomplete error (no dropdown, no crash)", async () => {
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false, isError: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin" } });

    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText("search.searchCategory")).toBeNull();
    expect(useSearchStore.getState().suggestions).toEqual([]);
  });

  it("shows skeleton rows while autocomplete is loading", async () => {
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
    const { container } = renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin" } });

    // Production code renders exactly 3 skeleton rows while loading, each with
    // 1 circular + 2 text Skeletons = 9 `.MuiSkeleton-root` nodes (SearchBar.tsx:1276-1289).
    await waitFor(() => {
      expect(container.querySelectorAll(".MuiSkeleton-root").length).toBe(9);
    });
  });

  it("nearby mode: lists categories, launches from a click, and cancel restores the place panel", () => {
    const anchor = {
      id: "p1",
      name: "Alexanderplatz",
      coordinates: [13.41, 52.52],
    } as unknown as Place;
    useCategorySearchStore.setState({ anchor, exploreBoxOpen: false });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);

    screen.getByText("Restaurants");

    fireEvent.click(screen.getByText("Restaurants"));
    // "restaurants" is the real CATEGORY_DEFINITIONS id for the "Restaurants"
    // chip (integrations/poi-search/types.ts) — asserted exactly rather than
    // via `expect.any(String)`, which this repo's local vitest.d.ts type shim
    // (apps/web/src/vitest.d.ts) does not declare.
    expect(launchExploreFromPlace).toHaveBeenCalledWith(
      fakeMap.map,
      expect.objectContaining({ name: "Alexanderplatz" }),
      "restaurants",
      "Restaurants",
    );

    fireEvent.click(screen.getByLabelText("search.cancelNearby"));
    expect(useCategorySearchStore.getState().anchor).toBeNull();
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Alexanderplatz");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });
});
