import { afterEach, expect, it, vi } from "vitest";
import z from "zod/v4";
import { createApiClient } from "./client";
import { createOperationBinder } from "./operation-transport";

const client = createApiClient({ baseUrl: "https://saved.example", credentials: "include" });
afterEach(() => vi.unstubAllGlobals());
it("consumes a declared session download as a Blob within the request lifetime", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<gpx>café</gpx>", {
        headers: {
          "content-type": "application/gpx+xml; charset=utf-8",
          "content-disposition": "attachment; filename=trip.gpx",
        },
      }),
    ),
  );
  const bind = createOperationBinder({
    download: {
      method: "GET",
      path: "/api/saved/lists/:id/export",
      auth: "session",
      responses: {
        200: {
          kind: "text-download",
          mediaTypes: ["application/gpx+xml"],
          headers: z.object({ "content-disposition": z.string().startsWith("attachment;") }),
        },
      },
    },
  });
  const response = await bind("download")<{ data: Blob }>("/api/saved/lists/list/export", {
    client,
  });
  expect(response.data).toBeInstanceOf(Blob);
  expect(await response.data.text()).toBe("<gpx>café</gpx>");
});

it("rejects a different declared download format than the one requested", async () => {
  const { exportSavedList } = await import("./saved-sdk");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response("<kml/>", {
        headers: {
          "content-type": "application/vnd.google-earth.kml+xml",
          "content-disposition": "attachment; filename=trip.kml",
        },
      }),
    ),
  );
  await expect(exportSavedList("list", { format: "gpx" }, { client })).rejects.toThrow("contract");
});

it.each(["wrong-media", "missing-attachment", "oversized", "stalled"] as const)(
  "rejects %s downloads and releases the response body",
  async (scenario) => {
    const { exportSavedList } = await import("./saved-sdk");
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (scenario !== "stalled") controller.enqueue(new TextEncoder().encode("<gpx/>"));
      },
      cancel() {
        canceled = true;
      },
    });
    const headers = new Headers({
      "content-type": scenario === "wrong-media" ? "text/html" : "application/gpx+xml",
    });
    if (scenario !== "missing-attachment")
      headers.set("content-disposition", "attachment; filename=trip.gpx");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
    await expect(
      exportSavedList(
        "list",
        { format: "gpx" },
        { client, maxDownloadBytes: scenario === "oversized" ? 2 : 100, timeoutMs: 20 },
      ),
    ).rejects.toThrow();
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  },
);

it("honors caller cancellation during a pending download body", async () => {
  const { exportSavedList } = await import("./saved-sdk");
  const abort = new AbortController();
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      canceled = true;
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(body, {
        headers: {
          "content-type": "application/gpx+xml",
          "content-disposition": "attachment; filename=trip.gpx",
        },
      }),
    ),
  );
  const pending = exportSavedList("list", { format: "gpx" }, { client, signal: abort.signal });
  try {
    await vi.waitFor(() => expect(body.locked).toBe(true));
    abort.abort();
    await expect(pending).rejects.toThrow("aborted");
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  } finally {
    abort.abort();
    await pending.catch(() => {});
  }
});

it("cannot publish a completed download after cancellation wins at the consumption boundary", async () => {
  const { exportSavedList } = await import("./saved-sdk");
  const abort = new AbortController();
  const response = new Response("<gpx/>", {
    headers: {
      "content-type": "application/gpx+xml",
      "content-disposition": "attachment; filename=trip.gpx",
    },
  });
  const readHeader = response.headers.get.bind(response.headers);
  let mediaReads = 0;
  vi.spyOn(response.headers, "get").mockImplementation((name) => {
    if (name === "content-type" && ++mediaReads === 2) abort.abort();
    return readHeader(name);
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  await expect(
    exportSavedList("list", { format: "gpx" }, { client, signal: abort.signal }),
  ).rejects.toThrow("aborted");
  expect(mediaReads).toBe(2);
});
