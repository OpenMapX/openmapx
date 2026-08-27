import { NetworkOnly, type RouteHandlerCallback } from "serwist";
import {
  handleNetworkOnlyNavigation,
  navigationCachePolicy,
  type STATIC_OFFLINE_FALLBACK_URL,
} from "./swCaches";

type NavigationCacheStorage = Pick<CacheStorage, "open">;

export type NavigationRuntimeRoute = {
  matcher(options: { request: Request }): boolean;
  handler: RouteHandlerCallback;
};

/**
 * Assemble the production navigation route around Serwist's real NetworkOnly
 * strategy. Keeping this assembly importable lets the regression harness
 * exercise the same strategy and Cache Storage dependency as the worker.
 */
export function createNavigationRuntimeRoute({
  appShellCacheName,
  cacheStorage = caches,
}: {
  appShellCacheName: string;
  cacheStorage?: NavigationCacheStorage;
}): NavigationRuntimeRoute {
  const strategy = new NetworkOnly();

  return {
    matcher: ({ request }) => navigationCachePolicy(request) !== null,
    handler: (options) =>
      handleNetworkOnlyNavigation({
        request: options.request,
        networkOnly: () => strategy.handle(options),
        matchOffline: async (url: typeof STATIC_OFFLINE_FALLBACK_URL, matchOptions) =>
          (await cacheStorage.open(appShellCacheName)).match(url, matchOptions),
      }),
  };
}
