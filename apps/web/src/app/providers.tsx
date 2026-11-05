"use client";

import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import {
  configureStorage,
  useDirectionsStore,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { registerBuiltinIdSchemeViews } from "@openmapx/place-ids";
import { QueryClientProvider } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminDraftRoot } from "@/lib/admin/AdminDraftProvider";
import { ImpersonationBanner } from "../components/admin/ImpersonationBanner";
import { SavedPlacesMirror } from "../components/pwa/SavedPlacesMirror";
import { ThemeColorSync } from "../components/pwa/ThemeColorSync";
import { createAppQueryClient } from "../lib/appQueryClient";
import { appTheme } from "../lib/appTheme";
import { CarDestinationsPublisher } from "../lib/mobile/CarDestinationsPublisher";
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
import { CarProviders } from "./car/CarProviders";

/**
 * Identifies this deployment to the installed shell during the handshake, so a
 * shell can report which page build it is talking to without the page having to
 * guess. A missing value is reported as such rather than faked.
 */
const WEB_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? "dev";

configureStorage(localStorageAdapter);
registerBuiltinIdSchemeViews();

export function Providers({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return pathname === "/car" ? (
    <CarProviders>{children}</CarProviders>
  ) : (
    <PhoneProviders>{children}</PhoneProviders>
  );
}

function PhoneProviders({ children }: { children: React.ReactNode }) {
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
    <ThemeProvider theme={appTheme}>
      <CssBaseline />
      <ThemeColorSync />
      {/*
        These teardown-only guards must observe the raw session transition even
        while the private tree is gated, so old in-memory keys and timeline
        queries are cleared before the replacement authority is released.
      */}
      <MangroveSignerSessionGuard />
      <PersonalTimelineSessionGuard />
      <AdminDraftRoot>
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
              <CarDestinationsPublisher />
              <IntegrationProvider>{children}</IntegrationProvider>
            </MobileRuntimeProvider>
          </MangroveTransportProvider>
        </SessionAuthorityBoundary>
      </AdminDraftRoot>
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
