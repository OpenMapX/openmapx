import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "junctionPhotoCaption")
      return `© ${String(values?.author)} · ${String(values?.license)} · ${String(values?.date)}`;
    return key;
  },
  useLocale: () => "en",
}));

import type { JunctionDecisionPoint, LngLat, StreetLevelImage } from "@openmapx/core";
import { JunctionPhoto } from "./JunctionPhoto";

/** A straight road running due east, ~314 m long, at the fixture's latitude. */
const geometry: LngLat[] = [
  [0, 51.18],
  [0.0045, 51.18],
];

/** The split 200 m along; the photo is taken 100 m along, 100 m before it. */
const point: JunctionDecisionPoint = {
  stepIndex: 1,
  kind: "exit",
  side: "right",
  point: [0.0028653, 51.18],
  alongMeters: 200,
  approachBearing: 90,
  divergenceDeg: 20,
  activeLanes: [],
};

const flatImage: StreetLevelImage = {
  id: "photo-1",
  providerId: "panoramax",
  lngLat: [0.0014327, 51.18],
  heading: 90,
  capturedAt: "2019-09-10T06:24:40+00:00",
  isPano: false,
  fovDeg: 70,
  assets: {},
  author: "motocultrice",
  license: "CC BY-SA 4.0",
};

/** The centre-line samples the overlay drew, as `[x, y]` pairs. */
function pathPoints(html: string): [number, number][] {
  const attribute = html.match(/data-photo-path="([^"]+)"/)?.[1];
  return (attribute ?? "")
    .split(" ")
    .filter(Boolean)
    .map((pair) => pair.split(",").map(Number) as [number, number]);
}

describe("JunctionPhoto", () => {
  it("renders a hidden image, the projected route path, and a licence caption", () => {
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    expect(html).toContain("aria-hidden");
    expect(html).toContain('alt=""');
    expect(html).toContain("blob:photo-1");
    expect(html).toContain("data-photo-path");
    expect(html).toContain("© motocultrice · CC BY-SA 4.0 · Sep 2019");
    expect(html).not.toContain("<a ");
    // A straight road ahead projects up the middle of the frame, near points low.
    const points = pathPoints(html);
    expect(points.length).toBeGreaterThan(5);
    expect(points[0][0]).toBeCloseTo(50, 0);
    expect(points[0][1]).toBeGreaterThan(points[points.length - 1][1]);
  });

  it("crops the overlay with the photo instead of stretching it", () => {
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    // The image is displayed with `cover`; the overlay uses the matching SVG
    // rule over a viewBox of the source's own shape, so both crop alike.
    expect(html).toContain('preserveAspectRatio="xMidYMid slice"');
    expect(html).toContain('viewBox="0 0 100 75"');
  });

  it("shapes the overlay to the photo's own frame when the provider reports it", () => {
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={{ ...flatImage, aspectRatio: 16 / 9 }}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    expect(html).toContain('viewBox="0 0 100 56.25"');
  });

  it("re-shapes the overlay once the loaded photo reveals its own frame", () => {
    const { container } = render(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    expect(container.querySelector("[data-photo-path]")?.getAttribute("viewBox")).toBe(
      "0 0 100 75",
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 2048, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 1024, configurable: true });
    fireEvent.load(img);
    expect(container.querySelector("[data-photo-path]")?.getAttribute("viewBox")).toBe(
      "0 0 100 50",
    );
  });

  it("moves the drawn path into the exit lane the gantry names", () => {
    // Shot on the carriageway's centre line of three lanes; the exit leaves the right one.
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
        exitLanes={{ laneCount: 3, activeLanes: [2] }}
      />,
    );
    expect(html).toContain('data-lane-shift="3.5"');
  });

  it("leaves the photo bare when the route cannot be projected onto it", () => {
    const offRoute: StreetLevelImage = { ...flatImage, lngLat: [0.0014327, 51.1808] };
    const html = renderToStaticMarkup(
      <JunctionPhoto image={offRoute} objectUrl="blob:photo-1" point={point} geometry={geometry} />,
    );
    expect(html).toContain("blob:photo-1");
    expect(html).not.toContain("data-photo-path");
  });

  it("renders a cropped window for a panorama, offset from the image's own heading", () => {
    const pano: StreetLevelImage = { ...flatImage, isPano: true, fovDeg: 360 };
    const html = renderToStaticMarkup(
      <JunctionPhoto image={pano} objectUrl="blob:pano-1" point={point} geometry={geometry} />,
    );
    // The window is centred on the road ahead, which runs due east here.
    expect(Number(html.match(/data-crop-start="([^"]+)"/)?.[1])).toBeCloseTo(45, 1);
    expect(html).toContain('data-crop-span="90"');
    // The image centre faces 90°, so its left edge is 270°; a window starting
    // at 45° begins 135° in — one and a half windows of a four-window strip.
    expect(Number(html.match(/data-left-percent="([^"]+)"/)?.[1])).toBeCloseTo(-150, 1);
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it("completes a window that wraps past the image edge with a second copy", () => {
    // A frame facing 300° cannot show the road ahead, so no path is drawn, but
    // the 90° window onto the approach still has to be assembled.
    const pano: StreetLevelImage = { ...flatImage, isPano: true, fovDeg: 360, heading: 300 };
    const html = renderToStaticMarkup(
      <JunctionPhoto image={pano} objectUrl="blob:pano-1" point={point} geometry={geometry} />,
    );
    expect(html).not.toContain("data-photo-path");
    expect(html.match(/<img/g)).toHaveLength(2);
    // Window start 45° is 285° in from the 120° left edge; the second copy sits
    // one full strip (400%) to the right.
    const offsets = [...html.matchAll(/data-left-percent="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(offsets[0]).toBeCloseTo(-(285 / 90) * 100, 1);
    expect(offsets[1]).toBeCloseTo(-(285 / 90) * 100 + 400, 1);
  });

  it("credits the provider when the image carries no author", () => {
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={{ ...flatImage, author: undefined }}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    expect(html).toContain("© panoramax · CC BY-SA 4.0 · Sep 2019");
  });
});
