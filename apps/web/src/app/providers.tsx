"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { configureStorage } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { localStorageAdapter } from "../lib/storage";
import { IntegrationProvider } from "../providers/IntegrationProvider";

configureStorage(localStorageAdapter);

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

  useEffect(() => {
    // Only register in production — sw.js is only generated during `next build`.
    // Matches the `disable: NODE_ENV === "development"` in next.config.ts.
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      // Dynamic import — @serwist/window is client-only, must not run on server
      import("@serwist/window").then(({ Serwist }) => {
        const sw = new Serwist("/sw.js", { scope: "/" });
        sw.register().catch((err) => console.warn("SW registration failed:", err));
      });
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <IntegrationProvider>{children}</IntegrationProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
