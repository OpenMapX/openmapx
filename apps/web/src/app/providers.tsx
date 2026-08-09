"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import {
  configureStorage,
  useDirectionsStore,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect, useState } from "react";
// Side-effect import: populates globalThis.__OMX_RUNTIME__ so community bundles
// resolve react/@openmapx/* to the host's singletons (must run before any
// community bundle script is appended by IntegrationProvider).
import "../lib/communityRuntime";
import { ImpersonationBanner } from "../components/admin/ImpersonationBanner";
import { SavedPlacesMirror } from "../components/pwa/SavedPlacesMirror";
import { createIdbPersister } from "../lib/queryPersister";
import {
  enforceRecentMapDataCachePreference,
  isRecentMapDataQueryKey,
  QUERY_CACHE_KEY,
} from "../lib/recentMapDataCache";
import { localStorageAdapter } from "../lib/storage";
import { IntegrationProvider } from "../providers/IntegrationProvider";
import { KeypairSessionGuard } from "../providers/KeypairSessionGuard";
import { MangroveTransportProvider } from "../providers/MangroveTransportProvider";
import { PersonalTimelineSessionGuard } from "../providers/PersonalTimelineSessionGuard";

configureStorage(localStorageAdapter);
registerBuiltinIdSchemeViews();

const theme = createTheme({
  cssVariables: {
    colorSchemeSelector: "class",
    disableCssColorScheme: true,
  },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: "#207E23", contrastText: "#ffffff" },
        secondary: { main: "#34A853" },
        background: { default: "#f5f5f5", paper: "#ffffff" },
        text: { primary: "#202124", secondary: "#5f6368" },
        error: { main: "#d32f2f" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#71D674", contrastText: "#000000" },
        secondary: { main: "#81C995" },
        background: { default: "#1C1C1C", paper: "#2D2D2D" },
        text: { primary: "#E8EAED", secondary: "#9AA0A6" },
        error: { main: "#F28B82" },
      },
    },
  },
  defaultColorScheme: "light",
  typography: {
    fontFamily: '"Plus Jakarta Sans", Arial, sans-serif',
    fontSize: 14,
    button: {
      textTransform: "none",
      fontWeight: 500,
    },
  },
  shape: {
    borderRadius: 8,
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
          borderRadius: 8,
        },
      },
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60_000,
            retry: 1,
            // Keep cached data in memory for 24h so stale results remain
            // available when the user goes offline during a session.
            gcTime: 24 * 60 * 60 * 1000,
          },
        },
      }),
  );

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
    // Same for the navigation voice / keep-screen-on toggle preferences.
    useNavigationStore.getState().hydrate();
    // And the persisted route-avoidance defaults.
    useDirectionsStore.getState().hydrateRoutePrefs();
  }, []);

  const inner = (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ImpersonationBanner />
      <SavedPlacesMirror />
      <MangroveTransportProvider>
        <KeypairSessionGuard />
        <PersonalTimelineSessionGuard />
        <IntegrationProvider>{children}</IntegrationProvider>
      </MangroveTransportProvider>
    </ThemeProvider>
  );

  if (persister) {
    return (
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 24 * 60 * 60 * 1000,
          buster: "v1",
          dehydrateOptions: {
            shouldDehydrateQuery: (q) =>
              q.state.status === "success" && isRecentMapDataQueryKey(q.queryKey),
          },
        }}
      >
        {inner}
      </PersistQueryClientProvider>
    );
  }

  return <QueryClientProvider client={queryClient}>{inner}</QueryClientProvider>;
}
