import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLEARABLE_TILE_CACHES,
  MAP_TILE_CACHE,
  STREET_LEVEL_IMAGERY_TILE_CACHE,
  VECTOR_TILE_CACHE,
} from "@/lib/swCaches";
import { cleanup, render, screen, userEvent, waitFor } from "@/test";

// A stable translator, as next-intl returns: the dialog re-inspects storage whenever it changes.
vi.mock("next-intl", async () => {
  const translate = (key: string) => `settings.${key}`;
  return (await import("@/test/intl")).mockNextIntl({ useTranslations: () => translate });
});
vi.mock("@/lib/offlineAreas", () => ({
  createOfflinePackageStorage: () => ({ list: async () => [] }),
}));
vi.mock("@/lib/persistentStorage", () => ({
  isStoragePersisted: async () => false,
  persistentStorageSupported: () => false,
  requestPersistentStorage: async () => false,
}));
vi.mock("@/lib/recentMapDataCache", () => ({
  clearRecentMapDataCache: async () => {},
  getStoredQueryCacheBytes: async () => 0,
  isRecentMapDataCacheEnabled: () => false,
  isRecentMapDataQueryKey: () => false,
  setRecentMapDataCacheEnabled: async () => {},
}));

import { StorageDialog } from "./StorageDialog";

const deleted: string[] = [];

beforeEach(() => {
  deleted.length = 0;
  vi.stubGlobal("caches", {
    keys: async () => [],
    open: async () => ({ keys: async () => [], match: async () => undefined }),
    delete: async (name: string) => {
      deleted.push(name);
      return true;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("StorageDialog clear cached tiles", () => {
  it("deletes the caches the service worker fills, street-level imagery tiles included", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <StorageDialog open onClose={() => {}} />
      </QueryClientProvider>,
    );

    const clear = await screen.findByRole("button", { name: "settings.clearTiles" });
    await waitFor(() => expect((clear as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(clear);

    await waitFor(() => expect(deleted).toHaveLength(CLEARABLE_TILE_CACHES.length));
    expect([...deleted].sort()).toEqual(
      [MAP_TILE_CACHE, STREET_LEVEL_IMAGERY_TILE_CACHE, VECTOR_TILE_CACHE].sort(),
    );
    expect(deleted).not.toContain("mapillary-tiles");
  });
});
