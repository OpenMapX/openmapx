"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import {
  configureStorage,
  useDirectionsStore,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { THEME_COLORS, THEME_CORNER_RADIUS, type ThemeColors } from "@openmapx/core/theme";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ImpersonationBanner } from "../components/admin/ImpersonationBanner";
import { SavedPlacesMirror } from "../components/pwa/SavedPlacesMirror";
import { ThemeColorSync } from "../components/pwa/ThemeColorSync";
import { createAppQueryClient } from "../lib/appQueryClient";
import { MobileRuntimeProvider } from "../lib/mobile/MobileRuntimeProvider";
import {
  PERSONAL_TIMELINE_CACHE_BUSTER,
  removePersonalTimelineMutations,
  shouldDehydrateOpenMapXMutation,
} from "../lib/personalTimelineCachePolicy";
import { installHighCardinalityQueryCacheBudget } from "../lib/queryCacheBudget";
import { createIdbPersister } from "../lib/queryPersister";
import { RecentMapDataQueryProvider } from "../lib/RecentMapDataQueryProvider";
import {
  enforceRecentMapDataCachePreference,
  isRecentMapDataQueryKey,
  QUERY_CACHE_KEY,
} from "../lib/recentMapDataCache";
import { localStorageAdapter } from "../lib/storage";
import { IntegrationProvider } from "../providers/IntegrationProvider";
import { KeypairSessionGuard } from "../providers/KeypairSessionGuard";
import { MangroveSignerSessionGuard } from "../providers/MangroveSignerSessionGuard";
import { MangroveTransportProvider } from "../providers/MangroveTransportProvider";
import { PersonalTimelineSessionGuard } from "../providers/PersonalTimelineSessionGuard";
import { SessionAuthorityBoundary } from "../providers/SessionAuthorityBoundary";
import { subscribeRecentSearchStorage, useRecentSearchStore } from "../stores/recentSearchStore";

/**
 * Identifies this deployment to the installed shell during the handshake, so a
 * shell can report which page build it is talking to without the page having to
 * guess. A missing value is reported as such rather than faked.
 */
const WEB_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

configureStorage(localStorageAdapter);
registerBuiltinIdSchemeViews();

/** The shared OpenMapX colours, which the installed app's native screens use too. */
function muiPalette(colors: ThemeColors) {
  return {
    primary: { main: colors.primary, contrastText: colors.onPrimary },
    secondary: { main: colors.secondary },
    background: { default: colors.background, paper: colors.surface },
    text: { primary: colors.text, secondary: colors.textSecondary },
    error: { main: colors.error },
  };
}

const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: "class",
    disableCssColorScheme: true,
  },
  colorSchemes: {
    light: { palette: muiPalette(THEME_COLORS.light) },
    dark: { palette: muiPalette(THEME_COLORS.dark) },
  },
  defaultColorScheme: "light",
  typography: {
    fontFamily: '"Plus Jakarta Sans Variable", Arial, sans-serif',
    fontSize: 14,
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: THEME_CORNER_RADIUS,
  },
  components: {
    MuiPaper: {
      defaultProps: { elevation: 0 },
    },
    MuiAccordion: {
      styleOverrides: {
        // MUI draws a top divider via an ::before pseudo-element intended for
        // flush-stacked accordions. Every accordion in this app is a spaced,
        // outlined/bordered card where it just floats as a stray line above
        // each one — disable it globally so panels don't need to fix it locally.
        root: {
          "&::before": { display: "none" },
        },
      },
    },
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: THEME_CORNER_RADIUS,
        },
      },
    },
    // The installed app draws the page under the status and navigation bars
    // (`viewport-fit=cover`), so every dialog and drawer keeps its content out
    // of them. In a plain browser tab the insets are 0.
    MuiDialog: {
      styleOverrides: {
        // A floating dialog is centred and sized within the safe area.
        container: ({ ownerState }) =>
          ownerState.fullScreen
            ? {}
            : {
                boxSizing: "border-box",
                paddingTop: "var(--omx-safe-top)",
                paddingBottom: "var(--omx-safe-bottom)",
                paddingLeft: "var(--omx-safe-left)",
                paddingRight: "var(--omx-safe-right)",
              },
        // A full-screen dialog still covers the bars, with its content inset.
        paperFullScreen: {
          boxSizing: "border-box",
          paddingTop: "var(--omx-safe-top)",
          paddingBottom: "var(--omx-safe-bottom)",
          paddingLeft: "var(--omx-safe-left)",
          paddingRight: "var(--omx-safe-right)",
        },
      },
    },
    MuiDrawer: {
      styleOverrides: {
        // The screen edge the drawer is attached to and the two beside it;
        // its open side faces the page, not a system bar.
        paper: ({ ownerState }) => ({
          ...(ownerState.anchor !== "bottom" && { paddingTop: "var(--omx-safe-top)" }),
          ...(ownerState.anchor !== "top" && { paddingBottom: "var(--omx-safe-bottom)" }),
          ...(ownerState.anchor !== "right" && { paddingLeft: "var(--omx-safe-left)" }),
          ...(ownerState.anchor !== "left" && { paddingRight: "var(--omx-safe-right)" }),
        }),
      },
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => createAppQueryClient());

  // Persister is created lazily client-side so SSR doesn't touch storage. Backed
  // by IndexedDB (not localStorage) so the persisted cache has real headroom.
  const [persister] = useState(() =>
    typeof window === "undefined" ? null : createIdbPersister(QUERY_CACHE_KEY),
  );

  useEffect(() => {
    void enforceRecentMapDataCachePreference();
    // Storage is configured at module scope above, but the settings store may
    // have initialized before that ran; re-read the persisted units preference.
    useSettingsStore.getState().hydrate();
    useRecentSearchStore.getState().hydrate();
    // Same for the navigation voice / keep-screen-on toggle preferences.
    useNavigationStore.getState().hydrate();
    // And the persisted route-avoidance defaults.
    useDirectionsStore.getState().hydrateRoutePrefs();
  }, []);

  useEffect(() => subscribeRecentSearchStorage(), []);

  useEffect(() => installHighCardinalityQueryCacheBudget(queryClient), [queryClient]);

  const inner = (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ThemeColorSync />
      {/*
        These teardown-only guards must observe the raw session transition even
        while the private tree is gated, so old in-memory keys and timeline
        queries are cleared before the replacement authority is released.
      */}
      <MangroveSignerSessionGuard />
      <PersonalTimelineSessionGuard />
      <SessionAuthorityBoundary>
        <KeypairSessionGuard />
        <ImpersonationBanner />
        <SavedPlacesMirror />
        <MangroveTransportProvider>
          {/*
            Mounted outside `IntegrationProvider` on purpose: the installed shell
            forbids executing administrator-installed frontend bundles, and that
            guard has to be answerable before the provider that would append them.
          */}
          <MobileRuntimeProvider webBuildId={WEB_BUILD_ID}>
            <IntegrationProvider>{children}</IntegrationProvider>
          </MobileRuntimeProvider>
        </MangroveTransportProvider>
      </SessionAuthorityBoundary>
    </ThemeProvider>
  );

  if (persister) {
    return (
      <RecentMapDataQueryProvider
        client={queryClient}
        onSuccess={() => removePersonalTimelineMutations(queryClient)}
        persistOptions={{
          persister,
          maxAge: 24 * 60 * 60 * 1000,
          buster: PERSONAL_TIMELINE_CACHE_BUSTER,
          dehydrateOptions: {
            shouldDehydrateMutation: shouldDehydrateOpenMapXMutation,
            shouldDehydrateQuery: (q) =>
              q.state.status === "success" && isRecentMapDataQueryKey(q.queryKey),
          },
        }}
      >
        {inner}
      </RecentMapDataQueryProvider>
    );
  }

  return <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>;
}
