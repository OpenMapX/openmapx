import type { IntegrationContext } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { createOsmImagePhotoProvider, searchHeroPhotos, searchPhotos } from "./orchestrator";

function response() {
  return {
    query: {
      pages: {
        1: {
          title: "File:Photo.jpg",
          imageinfo: [
            {
              url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg",
              mime: "image/jpeg",
              extmetadata: {
                Artist: { value: "Creator" },
                LicenseShortName: { value: "CC BY 4.0" },
                LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
              },
            },
          ],
        },
      },
    },
  };
}
function context(get: ReturnType<typeof vi.fn>, blocked: string[] = []) {
  return {
    http: { get },
    getDisallowedSourceIds: async () => new Set(blocked),
  } as unknown as IntegrationContext;
}
describe("contextual OSM Commons acquisition", () => {
  it("uses host HTTP and the gallery operation signal with a bounded deadline", async () => {
    const get = vi.fn(async () => response());
    const signal = new AbortController().signal;
    const photos = await searchPhotos(
      { lat: 50, lng: 8, osmTags: { image: "File:Photo.jpg" }, signal },
      [createOsmImagePhotoProvider(context(get))],
    );
    expect(photos[0]).toMatchObject({ author: "Creator", source: "wikimedia-commons" });
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("commons.wikimedia.org/w/api.php"),
      expect.objectContaining({ signal, timeoutMs: 4000 }),
    );
  });
  it("does not acquire a disabled Commons source", async () => {
    const get = vi.fn(async () => response());
    expect(
      await searchHeroPhotos({ image: "File:Photo.jpg" }, [
        createOsmImagePhotoProvider(context(get, ["wikimedia-commons"])),
      ]),
    ).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
  it("does not acquire after the caller already cancelled", async () => {
    const get = vi.fn(async () => response());
    const controller = new AbortController();
    controller.abort();
    expect(
      await searchHeroPhotos(
        { image: "File:Photo.jpg" },
        [createOsmImagePhotoProvider(context(get))],
        { signal: controller.signal },
      ),
    ).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });
  it("defers Commons bytes when no contextual acquisition provider is registered", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected global request"));
    try {
      expect(await searchHeroPhotos({ image: "File:Photo.jpg" }, [])).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
