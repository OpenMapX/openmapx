"use client";

import { useColorScheme } from "@mui/material/styles";
import type { Command } from "@openmapx/command-palette";
import { parseShortcut } from "@openmapx/command-palette";
import {
  CATEGORY_DEFINITIONS,
  coordinateId,
  createPlace,
  isOverlayActive,
  PANEL,
  toggleOverlay,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useLayerStore,
  useMapStore,
  useMenuStore,
  useParkedLocations,
  useParkingStore,
  usePlaceStore,
  useSearchStore,
  useSession,
  useSidebarStore,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { localeNames, locales } from "@/i18n/config";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { shareCurrentUrl } from "@/lib/deepLink";
import { setLocaleAndReload } from "@/lib/setLocale";
import { useAlignToStreets } from "@/lib/useAlignToStreets";
import { LAYER_SELECTOR_OPEN_EVENT } from "./constants";
import { useMyLocation } from "./useMyLocation";

const PARSED = {
  saved: parseShortcut("g s"),
  directions: parseShortcut("g d"),
  nearby: parseShortcut("g n"),
  menu: parseShortcut("g m"),
  layers: parseShortcut("g l"),
  theme: parseShortcut("t"),
  myLocation: parseShortcut("."),
  shortcuts: parseShortcut("?"),
};

/** Overlay ID mapping: integration IDs like "overlay-earthquakes" -> "earthquakes". */
function integrationIdToOverlayId(integrationId: string): string {
  if (integrationId === "overlay-traffic-tomtom") return "traffic";
  // Every street-level-imagery provider shares a single overlay toggle and exclusion group.
  if (integrationId.startsWith("street-level-imagery-")) return "street-level-imagery";
  return integrationId.replace(/^overlay-/, "").replace(/^tool-/, "");
}

interface UseCommandSourcesOptions {
  /** Called by the "Show keyboard shortcuts" command. */
  openShortcutsDialog: () => void;
}

export function useCommandSources({ openShortcutsDialog }: UseCommandSourcesOptions): Command[] {
  const t = useTranslations("commandPalette");
  const locale = useLocale();
  const { setMode, mode } = useColorScheme();
  const myLocation = useMyLocation();
  const mapCtx = useMapOptional();
  const hasMap = mapCtx !== null;
  const { available: alignAvailable, align } = useAlignToStreets();
  const integrations = useIntegrationRegistry();
  const { data: session } = useSession();
  const isSignedIn = !!session?.user?.id;
  const { data: parkedLocations } = useParkedLocations();

  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const globeView = useLayerStore((s) => s.globeView);

  return useMemo<Command[]>(() => {
    const out: Command[] = [];

    // Layers
    const baseLayers = [
      { id: "default", labelKey: "cmdLayerDefault", iconKey: "layer-default" as const },
      { id: "satellite", labelKey: "cmdLayerSatellite", iconKey: "layer-satellite" as const },
      { id: "terrain", labelKey: "cmdLayerTerrain", iconKey: "layer-terrain" as const },
      { id: "cycling", labelKey: "cmdLayerCycling", iconKey: "layer-cycling" as const },
    ] as const;

    for (const l of baseLayers) {
      out.push({
        id: `layers.${l.id}`,
        group: "layers",
        label: t(l.labelKey as never),
        iconKey: l.iconKey,
        isActive: () => activeLayer === l.id,
        run: () => {
          setActiveLayer(l.id);
          return false;
        },
      });
    }

    out.push({
      id: "layers.globe",
      group: "layers",
      label: t("cmdToggleGlobe"),
      iconKey: "globe",
      isActive: () => globeView,
      run: () => {
        // Read from the store at run-time so back-to-back invocations
        // (e.g. ⌘+Enter held) toggle robustly instead of all reading the
        // same captured value.
        const current = useLayerStore.getState().globeView;
        useLayerStore.getState().setGlobeView(!current);
        return false;
      },
    });

    // Overlays
    for (const integration of integrations.getEnabled()) {
      if (!integration.frontend?.overlay) continue;
      const overlayId = integrationIdToOverlayId(integration.id);
      const enStrings = integration.strings?.en as { name?: string } | undefined;
      const localeStrings = integration.strings?.[locale] as { name?: string } | undefined;
      const overlayLabel = localeStrings?.name ?? enStrings?.name ?? overlayId;

      // Keywords cover the canonical overlay id, the integration service id,
      // and the English name (locale-independent fallback). This means typing
      // "weather", "transit", etc. matches even when the user's locale uses a
      // different word for the displayed name. (scoreCommand lowercases.)
      const keywords = [overlayId, integration.id, enStrings?.name].filter((x): x is string =>
        Boolean(x),
      );

      out.push({
        id: `overlays.${overlayId}`,
        group: "overlays",
        label: t("cmdToggleOverlay", { name: overlayLabel }),
        iconKey: "overlay",
        keywords,
        isActive: () => isOverlayActive(overlayId),
        run: () => {
          toggleOverlay(overlayId, { kind: "user" });
          return false;
        },
      });
    }

    // Panels
    if (isSignedIn) {
      // Saved lists/labels are stored per-user behind auth — only surface
      // the command when the user can actually use it.
      out.push({
        id: "panels.saved",
        group: "panels",
        label: t("cmdOpenSaved"),
        iconKey: "saved",
        shortcut: PARSED.saved,
        run: () => useSidebarStore.getState().openSidebar(PANEL.SAVED),
      });
    }
    // Only reachable once something is parked; otherwise the command would open
    // a panel that immediately closes itself.
    if (parkedLocations && parkedLocations.length > 0) {
      const first = parkedLocations[0];
      out.push({
        id: "panels.parking",
        group: "panels",
        label: t("cmdOpenParking"),
        iconKey: "parking",
        run: () => {
          useParkingStore.getState().select(first.id);
          useSidebarStore.getState().openSidebar(PANEL.PARKING);
        },
      });
    }
    out.push(
      {
        id: "panels.directions",
        group: "panels",
        label: t("cmdOpenDirections"),
        iconKey: "directions",
        shortcut: PARSED.directions,
        run: () => {
          useDirectionsStore.getState().open();
          useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
        },
      },
      {
        id: "panels.nearby",
        group: "panels",
        label: t("cmdOpenNearby"),
        iconKey: "nearby",
        shortcut: PARSED.nearby,
        run: () => {
          // Prefer the currently-selected place; otherwise synthesise one at
          // the current map center so the panel has a meaningful source.
          const selected = usePlaceStore.getState().selectedPlace;
          const source =
            selected ??
            (() => {
              const center = useMapStore.getState().center;
              return createPlace({
                name: t("nearbyMapCenter"),
                address: "",
                coordinates: center,
                ids: { coordinate: coordinateId(center) },
                primaryScheme: "coordinate",
              });
            })();
          useCategorySearchStore.getState().openExploreBox(source);
        },
      },
      {
        id: "panels.menu",
        group: "panels",
        label: t("cmdOpenMenu"),
        iconKey: "menu",
        shortcut: PARSED.menu,
        run: () => useMenuStore.getState().open(),
      },
      {
        id: "panels.layers",
        group: "panels",
        label: t("cmdOpenLayers"),
        iconKey: "layer",
        shortcut: PARSED.layers,
        run: () => {
          window.dispatchEvent(new CustomEvent(LAYER_SELECTOR_OPEN_EVENT));
        },
      },
    );

    // Categories
    for (const cat of CATEGORY_DEFINITIONS) {
      out.push({
        id: `categories.${cat.id}`,
        group: "categories",
        label: t("cmdSearchCategory", { category: cat.label }),
        iconKey: "category",
        iconPath: cat.iconPath,
        keywords: [cat.id],
        run: () => {
          // Clear any active data source, set the active category,
          // populate the search bar, and open the category sidebar
          // panel so results actually render.
          useDataSourceStore.getState().setActiveSource(null);
          useCategorySearchStore.getState().setActiveCategory(cat.id);
          useSearchStore.getState().setQuery(cat.label);
          useSidebarStore.getState().openSidebar(PANEL.CATEGORY);
        },
      });
    }

    // Actions
    out.push(
      {
        id: "actions.share",
        group: "actions",
        label: t("cmdShareMap"),
        iconKey: "share",
        run: () => {
          void shareCurrentUrl({ title: "OpenMapX" });
        },
      },
      {
        id: "actions.theme",
        group: "actions",
        label: t("cmdToggleTheme"),
        iconKey: "theme",
        shortcut: PARSED.theme,
        keywords: ["dark", "light", "system", "night"],
        run: () => {
          // `mode` may be undefined before MUI's color-scheme hydration; treat
          // that as "system" so the first press is deterministic.
          const current = mode ?? "system";
          const next = current === "light" ? "dark" : current === "dark" ? "system" : "light";
          setMode(next);
          return false;
        },
      },
    );

    // "Go to my location" only makes sense on a map route; outside
    // <MapProvider> the command would silently no-op (no flyTo, no prompt).
    if (hasMap) {
      out.push({
        id: "actions.myLocation",
        group: "actions",
        label: t("cmdMyLocation"),
        iconKey: "my-location",
        shortcut: PARSED.myLocation,
        run: () => {
          myLocation();
        },
      });
      if (alignAvailable) {
        out.push({
          id: "actions.alignToStreets",
          group: "actions",
          label: t("cmdAlignToStreets"),
          iconKey: "align-streets",
          run: () => {
            // An outcome worth explaining is announced by the hook and shown by
            // the map chrome, so asking from here reads the same as the button.
            align();
          },
        });
      }
      out.push({
        id: "actions.northUp",
        group: "actions",
        label: t("cmdNorthUp"),
        iconKey: "north-up",
        run: () => {
          mapCtx?.resetBearing();
        },
      });
    }

    out.push({
      // Note: `KeyboardShortcutsDialog` filters this command out of its own
      // shortcut listing — the "Show keyboard shortcuts" row is hardcoded
      // under Navigation there to keep ⌘K / ? / `/` together. Renaming
      // `actions.shortcuts` will break that filter.
      id: "actions.shortcuts",
      group: "actions",
      label: t("cmdShowShortcuts"),
      iconKey: "help",
      shortcut: PARSED.shortcuts,
      run: () => {
        openShortcutsDialog();
      },
    });

    // Language switchers (one per non-current locale). Native names come from
    // the shared `localeNames` map in @openmapx/i18n.
    for (const loc of locales) {
      if (loc === locale) continue;
      const native = localeNames[loc] ?? loc;
      out.push({
        id: `actions.lang.${loc}`,
        group: "actions",
        label: t("cmdSwitchLanguage", { locale: native }),
        iconKey: "language",
        keywords: [loc, native],
        run: () => {
          void setLocaleAndReload(loc);
        },
      });
    }

    return out;
  }, [
    t,
    locale,
    activeLayer,
    setActiveLayer,
    globeView,
    integrations,
    isSignedIn,
    parkedLocations,
    mode,
    setMode,
    myLocation,
    hasMap,
    mapCtx,
    align,
    alignAvailable,
    openShortcutsDialog,
  ]);
}
