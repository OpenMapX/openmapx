import { createApiClient } from "@openmapx/core";
import { afterEach, expect, it, vi } from "vitest";
import { exportSavedList } from "./exportSavedList";

const client = createApiClient({ baseUrl: "https://saved.example", credentials: "include" });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  ["gpx", "application/gpx+xml", "<gpx>café</gpx>"],
  ["geojson", "application/geo+json", '{"type":"FeatureCollection","features":[]}'],
  ["kml", "application/vnd.google-earth.kml+xml", "<kml>café</kml>"],
] as const)(
  "downloads validated %s bytes through the configured application client",
  async (format, media, content) => {
    const blobs: Blob[] = [];
    const revoked: string[] = [];
    const NativeUrl = URL;
    vi.stubGlobal(
      "URL",
      class extends NativeUrl {
        static override createObjectURL(blob: Blob) {
          blobs.push(blob);
          return "blob:https://saved.example/export";
        }
        static override revokeObjectURL(url: string) {
          revoked.push(url);
        }
      },
    );
    let downloaded: string | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    const fetch = vi.fn().mockResolvedValue(
      new Response(content, {
        headers: {
          "content-type": `${media}; charset=utf-8`,
          "content-disposition": `attachment; filename=Trip.${format}`,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    await exportSavedList("list/1", format, `Trip.${format}`, { client });
    expect(fetch.mock.calls[0][0]).toBe(
      `https://saved.example/api/saved/lists/list%2F1/export?format=${format}`,
    );
    expect(downloaded).toBe(`Trip.${format}`);
    expect(blobs).toHaveLength(1);
    expect(blobs[0].type.split(";", 1)[0]).toBe(media);
    const text = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsText(blobs[0]);
    });
    expect(text).toBe(content);
    expect(revoked).toEqual(["blob:https://saved.example/export"]);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  },
);
it("does not create a browser download for an error representation", async () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ error: "List not found" }, { status: 404 })),
  );
  await expect(exportSavedList("missing", "gpx", "Trip.gpx", { client })).rejects.toThrow("404");
  expect(click).not.toHaveBeenCalled();
});

it("releases its Blob URL and temporary anchor when the browser rejects the download", async () => {
  const revoked: string[] = [];
  const NativeUrl = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeUrl {
      static override createObjectURL() {
        return "blob:https://saved.example/rejected";
      }
      static override revokeObjectURL(url: string) {
        revoked.push(url);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<gpx/>", {
        headers: {
          "content-type": "application/gpx+xml",
          "content-disposition": "attachment; filename=Trip.gpx",
        },
      }),
    ),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
    throw new Error("Download rejected");
  });
  try {
    await expect(exportSavedList("list", "gpx", "Trip.gpx", { client })).rejects.toThrow(
      "Download rejected",
    );
    expect(revoked).toEqual(["blob:https://saved.example/rejected"]);
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  } finally {
    document.querySelectorAll("a[download]").forEach((anchor) => {
      anchor.remove();
    });
  }
});
