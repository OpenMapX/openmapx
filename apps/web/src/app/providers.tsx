"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { configureStorage } from "@openmapx/core";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { useEffect, useState } from "react";
import { ImpersonationBanner } from "../components/admin/ImpersonationBanner";
import {
  enforceRecentMapDataCachePreference,
  isRecentMapDataCacheEnabled,
  isRecentMapDataQueryKey,
  QUERY_CACHE_KEY,
} from "../lib/recentMapDataCache";
import { localStorageAdapter } from "../lib/storage";
import { IntegrationProvider } from "../providers/IntegrationProvider";
import { KeypairSessionGuard } from "../providers/KeypairSessionGuard";
import { MangroveTransportProvider } from "../providers/MangroveTransportProvider";

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
        primary: { main: "#007b8b", contrastText: "#ffffff" },
        secondary: { main: "#34A853" },
        background: { default: "#f5f5f5", paper: "#ffffff" },
        text: { primary: "#202124", secondary: "#5f6368" },
        error: { main: "#d32f2f" },
      },
    },
    dark: {
      palette: {
        primary: { main: "#4DB6AC", contrastText: "#000000" },
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
    MuiIconButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
        },
      },
    },
  },
});

function createRecentMapDataQueryStorage() {
  return {
    getItem: (key: string) => {
      if (key === QUERY_CACHE_KEY && !isRecentMapDataCacheEnabled()) return null;
      return window.localStorage.getItem(key);
    },
    setItem: (key: string, value: string) => {
      if (key === QUERY_CACHE_KEY && !isRecentMapDataCacheEnabled()) return;
      window.localStorage.setItem(key, value);
    },
    removeItem: (key: string) => {
      window.localStorage.removeItem(key);
    },
  };
}

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

  // Persister is created lazily client-side so SSR doesn't touch localStorage.
  const [persister] = useState(() =>
    typeof window === "undefined"
      ? null
      : createSyncStoragePersister({
          storage: createRecentMapDataQueryStorage(),
          key: QUERY_CACHE_KEY,
          throttleTime: 1000,
        }),
  );

  useEffect(() => {
    void enforceRecentMapDataCachePreference();
  }, []);

  const inner = (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <ImpersonationBanner />
      <MangroveTransportProvider>
        <KeypairSessionGuard />
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
