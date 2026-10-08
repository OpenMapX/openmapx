import type { DataSourceDetailSection } from "@openmapx/core";
import {
  type I18nToken,
  isI18nToken,
  resolveToken,
  sharedStrings,
} from "@openmapx/integration-framework/strings";
import type { Camera, CameraView } from "@openmapx/mobility-core/camera";
import { describe, expect, it } from "vitest";
import { mapCameraToDetail, mapCameraToResult } from "../mapper.js";
import de from "../strings/de.json";
import en from "../strings/en.json";

const AT = "2026-10-08T08:00:00Z";

function text(t: unknown, locale = "en"): string {
  if (!isI18nToken(t)) return String(t);
  return resolveToken(t, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: { en, de },
  });
}

function view(over: Partial<CameraView> = {}): CameraView {
  return {
    key: "0",
    imageUrl: "https://weathercam.digitraffic.fi/C0150200.jpg",
    status: "online",
    imageAt: AT,
    stale: false,
    ...over,
  };
}

function camera(over: Partial<Camera> = {}): Camera {
  return {
    id: "oc:feature:fi-digitraffic-cameras:C01502",
    name: "Tie 1 Espoo",
    type: "weather",
    country: "FI",
    coordinates: [24.65, 60.2],
    detailUrl: "https://www.digitraffic.fi/kelikamerat/C01502",
    views: [view()],
    sources: ["fi-digitraffic-cameras"],
    attributions: [
      {
        sourceId: "fi-digitraffic-cameras",
        name: "Fintraffic / digitraffic.fi",
        url: "https://www.digitraffic.fi/",
        spdxLicense: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    ],
    ...over,
  };
}

const THREE_VIEWS = camera({
  views: [
    view({
      key: "C0150201",
      name: "Helsinkiin",
      imageUrl: "https://weathercam.digitraffic.fi/C0150201.jpg",
      refreshSec: 600,
      imageAt: "2026-10-08T07:50:00Z",
    }),
    view({
      key: "C0150202",
      name: "Turkuun",
      imageUrl: "https://weathercam.digitraffic.fi/C0150202.jpg",
      refreshSec: 600,
      imageAt: "2026-10-08T08:00:00Z",
    }),
    view({
      key: "C0150209",
      name: "Tienpinta",
      imageUrl: "https://weathercam.digitraffic.fi/C0150209.jpg",
      refreshSec: 600,
      imageAt: "2026-10-08T07:55:00Z",
    }),
  ],
});

function ofType(sections: DataSourceDetailSection[], type: DataSourceDetailSection["type"]) {
  return sections.filter((s) => s.type === type);
}

describe("mapCameraToResult", () => {
  it("carries the type as the variant, the sources, the credits and the newest image time", () => {
    const result = mapCameraToResult(THREE_VIEWS);

    expect(result.id).toBe("oc:feature:fi-digitraffic-cameras:C01502");
    expect(result.variant).toBe("weather");
    expect(result.source).toBe("fi-digitraffic-cameras");
    expect(result.sources).toEqual(["fi-digitraffic-cameras"]);
    expect(result.observedAt).toBe("2026-10-08T08:00:00Z");
    expect(result.status).toBe("operational");
    expect(result.attributions).toEqual([
      {
        text: "Fintraffic / digitraffic.fi",
        url: "https://www.digitraffic.fi/",
        license: "CC-BY-4.0",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      },
    ]);
  });

  it("summarises several views by their count and one view by its direction", () => {
    expect(text(mapCameraToResult(THREE_VIEWS).summary)).toBe("3 views");
    expect(text(mapCameraToResult(THREE_VIEWS).summary, "de")).toBe("3 Ansichten");
    expect(
      text(mapCameraToResult(camera({ views: [view({ direction: "Northbound" })] })).summary),
    ).toBe("Direction: Northbound");
    expect(text(mapCameraToResult(camera({ views: [view({ bearing: 270 })] })).summary)).toBe(
      "Direction: 270°",
    );
    expect(mapCameraToResult(camera()).summary).toBeUndefined();
  });

  it("is non-operational when every view is offline or stale", () => {
    const allDown = camera({
      views: [
        view({ key: "a", status: "offline" }),
        view({ key: "b", status: "stale" }),
        view({ key: "c", status: "online", stale: true }),
      ],
    });
    expect(mapCameraToResult(allDown).status).toBe("non-operational");
    expect(mapCameraToResult(camera({ views: [view({ status: "offline" })] })).status).toBe(
      "non-operational",
    );

    const oneUp = camera({ views: [view({ key: "a", status: "offline" }), view({ key: "b" })] });
    expect(mapCameraToResult(oneUp).status).toBe("operational");
    expect(mapCameraToResult(camera({ views: [view({ status: "unknown" })] })).status).toBe(
      "unknown",
    );
  });

  it("names a nameless camera by what it is", () => {
    const result = mapCameraToResult(camera({ name: "" }));
    expect(result.name).toBe("");
    expect(text(result.fallbackName)).toBe("Webcam");
    expect(text(result.fallbackName, "de")).toBe("Webcam");
  });

  it("leaves out an image time that is not a timestamp", () => {
    expect(
      mapCameraToResult(camera({ views: [view({ imageAt: "yesterday" })] })).observedAt,
    ).toBeUndefined();
  });
});

describe("mapCameraToDetail", () => {
  it("gives a three-view camera three image sections in view order, each refreshing and linked", () => {
    const detail = mapCameraToDetail(THREE_VIEWS);
    const images = ofType(detail.sections, "image");

    expect(images.map((s) => text(s.title))).toEqual(["Helsinkiin", "Turkuun", "Tienpinta"]);
    expect(images.map((s) => s.imageUrl)).toEqual([
      "https://weathercam.digitraffic.fi/C0150201.jpg",
      "https://weathercam.digitraffic.fi/C0150202.jpg",
      "https://weathercam.digitraffic.fi/C0150209.jpg",
    ]);
    expect(images.map((s) => s.captionTimestamp)).toEqual([
      "2026-10-08T07:50:00Z",
      "2026-10-08T08:00:00Z",
      "2026-10-08T07:55:00Z",
    ]);
    expect(images.every((s) => s.refreshSec === 600)).toBe(true);
    expect(images.every((s) => s.linkUrl === "https://www.digitraffic.fi/kelikamerat/C01502")).toBe(
      true,
    );
    expect(images.every((s) => s.sectionIcon === "videocam")).toBe(true);
    expect(text(images[0].imageAlt)).toBe("Tie 1 Espoo");
    expect(text(images[0].caption)).toBe("Updated");
  });

  it("puts the images first, then the streams, the player and the info table", () => {
    const detail = mapCameraToDetail(
      camera({
        playerEmbedUrl: "https://webcams.windy.com/webcams/public/embed/player/1/day",
        views: [view({ streamUrl: "https://s.example.org/live.m3u8", streamType: "hls" })],
        operator: { name: "Fintraffic" },
      }),
    );

    expect(detail.sections.map((s) => s.type)).toEqual(["image", "embed", "embed", "table"]);
  });

  it("titles a view by its direction, else its bearing, else its number, and keeps titles apart", () => {
    const detail = mapCameraToDetail(
      camera({
        views: [
          view({ key: "a", direction: "Northbound" }),
          view({ key: "b", bearing: 90 }),
          view({ key: "c" }),
          view({ key: "d", direction: "Northbound" }),
        ],
      }),
    );

    expect(ofType(detail.sections, "image").map((s) => text(s.title))).toEqual([
      "Northbound",
      "Facing 90°",
      "View 3",
      "Northbound (4)",
    ]);
  });

  it("gives a stream-only view an embed and no image", () => {
    const detail = mapCameraToDetail(
      camera({
        views: [
          view({
            imageUrl: undefined,
            streamUrl: "https://tdx.example.tw/stream/CCTV-1.m3u8",
            streamType: "hls",
          }),
        ],
      }),
    );

    expect(ofType(detail.sections, "image")).toEqual([]);
    const [embed] = ofType(detail.sections, "embed");
    expect(embed.embedUrl).toBe("https://tdx.example.tw/stream/CCTV-1.m3u8");
    expect(embed.embedType).toBe("video");
    expect(embed.sectionIcon).toBe("videocam");
    expect(text(embed.title)).toBe("Live stream");
  });

  it("plays an mp4 clip as video and opens any other stream in a frame", () => {
    const detail = mapCameraToDetail(
      camera({
        views: [
          view({
            key: "a",
            name: "Clip",
            streamUrl: "https://s3.example.org/a.mp4",
            streamType: "mp4",
          }),
          view({ key: "b", name: "Page", streamUrl: "https://s.example.org/player" }),
        ],
      }),
    );

    const embeds = ofType(detail.sections, "embed");
    expect(embeds.map((s) => s.embedType)).toEqual(["video", "iframe"]);
    expect(embeds.map((s) => text(s.title))).toEqual(["Live stream: Clip", "Live stream: Page"]);
  });

  it("shows the player behind the consent card, as a frame", () => {
    const detail = mapCameraToDetail(
      camera({
        views: [view({ imageRedistribution: "link_only" })],
        playerEmbedUrl: "https://webcams.windy.com/webcams/public/embed/player/1/day",
      }),
    );

    const [player] = ofType(detail.sections, "embed");
    expect(player.embedUrl).toBe("https://webcams.windy.com/webcams/public/embed/player/1/day");
    expect(player.embedType).toBe("iframe");
    expect(player.sectionIcon).toBe("open_in_new");
    expect(text(player.title)).toBe("Live / Timelapse");
  });

  it("says an offline or stale still is so, beside its time", () => {
    const detail = mapCameraToDetail(
      camera({
        views: [
          view({ key: "a", name: "A", status: "offline" }),
          view({ key: "b", name: "B", status: "stale" }),
          view({ key: "c", name: "C", stale: true }),
        ],
      }),
    );

    expect(ofType(detail.sections, "image").map((s) => text(s.caption))).toEqual([
      "Offline",
      "Not updated recently",
      "Not updated recently",
    ]);
  });

  it("lists the road, the provider and the refresh interval in the info table", () => {
    const detail = mapCameraToDetail(
      camera({
        operator: { name: "Fintraffic", website: "https://www.fintraffic.fi/" },
        views: [view({ key: "a", road: "E18", refreshSec: 600 }), view({ key: "b", road: "E18" })],
      }),
    );

    const [info] = ofType(detail.sections, "table");
    expect(info.sectionIcon).toBe("info");
    expect(info.rows?.map(([label, value]) => [text(label), text(value)])).toEqual([
      ["Road", "E18"],
      ["Provider", "Fintraffic"],
      ["Refresh", "Every 10 min"],
    ]);

    const seconds = mapCameraToDetail(camera({ views: [view({ refreshSec: 45 })] }));
    expect(
      ofType(seconds.sections, "table")[0].rows?.map(([label, value]) => [
        text(label),
        text(value),
      ]),
    ).toEqual([
      ["Provider", "Fintraffic / digitraffic.fi"],
      ["Refresh", "Every 45 s"],
    ]);
  });

  it("carries the credits, the sources and the camera's page as its website", () => {
    const detail = mapCameraToDetail(camera());

    expect(detail.id).toBe("oc:feature:fi-digitraffic-cameras:C01502");
    expect(detail.sources).toEqual(["fi-digitraffic-cameras"]);
    expect(detail.website).toBe("https://www.digitraffic.fi/kelikamerat/C01502");
    expect(detail.attributions?.[0]?.text).toBe("Fintraffic / digitraffic.fi");
  });

  it("drops a link that is not http(s)", () => {
    const detail = mapCameraToDetail(camera({ detailUrl: "javascript:alert(1)" }));

    expect(detail.website).toBeUndefined();
    expect(ofType(detail.sections, "image")[0].linkUrl).toBeUndefined();

    const viewLink = mapCameraToDetail(
      camera({ detailUrl: undefined, views: [view({ detailUrl: "javascript:alert(1)" })] }),
    );
    expect(ofType(viewLink.sections, "image")[0].linkUrl).toBeUndefined();
  });

  it("links each still to its own view's page first, then the camera's", () => {
    // A Windy webcam linked into a Digitraffic station: its still links to Windy, as Windy's terms ask.
    const detail = mapCameraToDetail(
      camera({
        views: [
          view({ key: "C0150201", name: "Helsinkiin" }),
          view({
            key: "windy-cameras/0",
            name: "Windy",
            imageUrl: "https://images-webcams.windy.com/35/1179853135/current/preview/x.jpg",
            detailUrl: "https://www.windy.com/webcams/1179853135",
            imageRedistribution: "link_only",
          }),
        ],
      }),
    );

    expect(ofType(detail.sections, "image").map((s) => s.linkUrl)).toEqual([
      "https://www.digitraffic.fi/kelikamerat/C01502",
      "https://www.windy.com/webcams/1179853135",
    ]);
    expect(detail.website).toBe("https://www.digitraffic.fi/kelikamerat/C01502");
  });

  it("emits a view without a still or a stream as nothing but the camera's page", () => {
    const detail = mapCameraToDetail(
      camera({
        detailUrl: "https://www.nps.gov/media/webcam/view.htm?id=1",
        views: [view({ imageUrl: undefined, status: "unknown" })],
      }),
    );

    expect(detail.sections.map((s) => s.type)).toEqual(["table"]);
    expect(detail.website).toBe("https://www.nps.gov/media/webcam/view.htm?id=1");
  });
});

/** Every token in `value`, nested ones included. */
function tokensIn(value: unknown, into: I18nToken[] = []): I18nToken[] {
  if (Array.isArray(value)) {
    for (const item of value) tokensIn(item, into);
  } else if (isI18nToken(value)) {
    into.push(value);
    for (const v of Object.values(value.values ?? {})) tokensIn(v, into);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) tokensIn(v, into);
  }
  return into;
}

function lookup(catalog: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node !== null && typeof node === "object"
          ? (node as Record<string, unknown>)[part]
          : undefined,
      catalog,
    );
}

/** Every leaf key of a catalogue, dotted. */
function leafKeys(catalog: unknown, prefix = ""): string[] {
  if (catalog === null || typeof catalog !== "object") return [prefix];
  return Object.entries(catalog).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

describe("webcam strings", () => {
  const results = [
    mapCameraToResult(camera({ name: "" })),
    mapCameraToResult(THREE_VIEWS),
    mapCameraToResult(camera({ views: [view({ direction: "N" })] })),
    mapCameraToResult(camera({ views: [view({ bearing: 270 })] })),
  ];
  const details = [
    mapCameraToDetail(
      camera({
        name: "",
        operator: { name: "Op" },
        playerEmbedUrl: "https://webcams.windy.com/p/1",
        views: [
          view({ key: "a", name: "A", road: "E18", refreshSec: 600 }),
          view({
            key: "b",
            direction: "N",
            status: "offline",
            streamUrl: "https://s.example.org/x",
          }),
          view({ key: "c", bearing: 10, status: "stale" }),
          view({ key: "d", refreshSec: 45 }),
          view({ key: "e", name: "A" }),
        ],
      }),
    ),
    mapCameraToDetail(camera({ views: [view({ imageUrl: undefined, streamUrl: "https://s/x" })] })),
    mapCameraToDetail(camera({ views: [view({ refreshSec: 45 })] })),
  ];
  const emitted = tokensIn([results, details]);

  it("titles, labels, captions and summaries are tokens, never raw text", () => {
    for (const detail of details) {
      for (const section of detail.sections) {
        expect(isI18nToken(section.title)).toBe(true);
        if (section.caption !== undefined) expect(isI18nToken(section.caption)).toBe(true);
        if (section.imageAlt !== undefined) expect(isI18nToken(section.imageAlt)).toBe(true);
        for (const row of section.rows ?? []) expect(isI18nToken(row[0])).toBe(true);
      }
    }
    for (const result of results) {
      if (result.summary !== undefined) expect(isI18nToken(result.summary)).toBe(true);
    }
  });

  it("every token the mapper emits exists in en and de", () => {
    const own = emitted.filter((t) => !t.$t.startsWith("shared."));
    expect(own.length).toBeGreaterThan(0);
    for (const t of own) {
      expect(lookup(en, t.$t), `en ${t.$t}`).toBeTypeOf("string");
      expect(lookup(de, t.$t), `de ${t.$t}`).toBeTypeOf("string");
    }
  });

  it("the catalogue holds only the tokens the mapper emits, in both languages", () => {
    const used = new Set(emitted.map((t) => t.$t));
    const listing = new Set(["name", "description"]);
    expect(leafKeys(en).filter((k) => !listing.has(k) && !used.has(k))).toEqual([]);
    expect(leafKeys(de).sort()).toEqual(leafKeys(en).sort());
  });
});
