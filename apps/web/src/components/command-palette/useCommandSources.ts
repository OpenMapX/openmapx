"use client";

import { useColorScheme } from "@mui/material/styles";
import type { Command } from "@openmapx/core";
import {
  CATEGORY_DEFINITIONS,
  coordinateId,
  createPlace,
  isOverlayActive,
  OVERLAY_REGISTRY,
  PANEL,
  parseShortcut,
  toggleOverlay,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  useIntegrationRegistry,
  useLayerStore,
  useMapStore,
  useMenuStore,
  useNearbyPlacesStore,
  usePlaceStore,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import { localeNames, locales } from "@/i18n/config";
import { shareCurrentUrl } from "@/lib/deepLink";
import { setLocaleAndReload } from "@/lib/setLocale";
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

interface UseCommandSourcesOptions {
  /** Called by the "Show keyboard shortcuts" command. */
  openShortcutsDialog: () => void;
}

export function useCommandSources({ openShortcutsDialog }: UseCommandSourcesOptions): Command[] {
  const t = useTranslations("commandPalette");
  const locale = useLocale();
  const { setMode, mode } = useColorScheme();
  const myLocation = useMyLocation();
  const integrations = useIntegrationRegistry();

  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const globeView = useLayerStore((s) => s.globeView);
  const setGlobeView = useLayerStore((s) => s.setGlobeView);

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
        setGlobeView(!globeView);
        return false;
      },
    });

    // Overlays
    for (const overlay of OVERLAY_REGISTRY) {
      const meta = overlay.serviceId ? integrations.get(overlay.serviceId) : undefined;
      const enStrings = meta?.strings?.en as { name?: string } | undefined;
      const localeStrings = meta?.strings?.[locale] as { name?: string } | undefined;
      const overlayLabel = localeStrings?.name ?? enStrings?.name ?? overlay.id;

      // Keywords cover the canonical overlay id, the integration service id,
      // and the English name (locale-independent fallback). This means typing
      // "weather", "transit", etc. matches even when the user's locale uses a
      // different word for the displayed name.
      const keywords = [overlay.id, overlay.serviceId, enStrings?.name]
        .filter((x): x is string => Boolean(x))
        .map((x) => x.toLowerCase());

      out.push({
        id: `overlays.${overlay.id}`,
        group: "overlays",
        label: t("cmdToggleOverlay", { name: overlayLabel }),
        iconKey: "overlay",
        keywords,
        isActive: () => isOverlayActive(overlay.id),
        run: () => {
          toggleOverlay(overlay.id);
          return false;
        },
      });
    }

    // Panels
    out.push(
      {
        id: "panels.saved",
        group: "panels",
        label: t("cmdOpenSaved"),
        iconKey: "saved",
        shortcut: PARSED.saved,
        run: () => useSidebarStore.getState().openSidebar(PANEL.SAVED),
      },
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
          useNearbyPlacesStore.getState().setSourcePlace(source);
          useSidebarStore.getState().openSidebar(PANEL.NEARBY);
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
          const next = mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
          setMode(next);
          return false;
        },
      },
      {
        id: "actions.myLocation",
        group: "actions",
        label: t("cmdMyLocation"),
        iconKey: "my-location",
        shortcut: PARSED.myLocation,
        run: () => {
          myLocation();
        },
      },
      {
        id: "actions.shortcuts",
        group: "actions",
        label: t("cmdShowShortcuts"),
        iconKey: "help",
        shortcut: PARSED.shortcuts,
        run: () => {
          openShortcutsDialog();
        },
      },
    );

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
        keywords: [loc, native.toLowerCase()],
        run: () => setLocaleAndReload(loc),
      });
    }

    return out;
  }, [
    t,
    locale,
    activeLayer,
    setActiveLayer,
    globeView,
    setGlobeView,
    integrations,
    mode,
    setMode,
    myLocation,
    openShortcutsDialog,
  ]);
}
