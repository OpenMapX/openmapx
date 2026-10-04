import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { dataSourceBrandImageId, loadDataSourceBrandMarker } from "./dataSourceBrandMarker";

afterEach(() => vi.unstubAllGlobals());

it("proxies provider logos, embeds the bytes and ignores stale image completion", async () => {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["logo"]) });
  vi.stubGlobal("fetch", fetcher);
  const images: { onload: () => void; src: string }[] = [];
  vi.stubGlobal(
    "Image",
    class {
      onload = () => {};
      onerror = () => {};
      src = "";
      constructor() {
        images.push(this);
      }
    },
  );
  const map = createFakeMap().map;
  let current = true;
  const url = "https://provider.example/real-logo.png";
  const pending = loadDataSourceBrandMarker(map, url, () => current);
  await waitFor(() => expect(images).toHaveLength(1));
  const requested = new URL(String(fetcher.mock.calls[0][0]), "http://localhost");
  expect(requested.pathname).toBe("/api/image-proxy");
  expect(requested.searchParams.get("url")).toBe(url);
  expect(decodeURIComponent(images[0].src)).toContain("data:application/octet-stream;base64,");
  current = false;
  images[0].onload();
  expect(await pending).toBe(false);
  expect(map.hasImage(dataSourceBrandImageId(url))).toBe(false);
  current = true;
  const fresh = loadDataSourceBrandMarker(map, url, () => current);
  await waitFor(() => expect(images).toHaveLength(2));
  images[1].onload();
  expect(await fresh).toBe(true);
  expect(map.hasImage(dataSourceBrandImageId(url))).toBe(true);
});

it("leaves the generic fallback when the proxy fails", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  const map = createFakeMap().map;
  const url = "https://provider.example/missing.png";
  expect(await loadDataSourceBrandMarker(map, url, () => true)).toBe(false);
  expect(map.hasImage(dataSourceBrandImageId(url))).toBe(false);
});
