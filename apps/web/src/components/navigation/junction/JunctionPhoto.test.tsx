import { readFileSync } from "node:fs";
import { act, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "junctionPhotoCaption")
      return `© ${String(values?.author)} · ${String(values?.license)} · ${String(values?.date)}`;
    return key;
  },
  useLocale: () => "en",
}));

import type {
  JunctionDecisionPoint,
  LngLat,
  PhotoRoutePath,
  StreetLevelImage,
} from "@openmapx/core";
import { alignPhotoRoad, projectRoutePath } from "@openmapx/core/navigation";
import { JunctionPhoto } from "./JunctionPhoto";
import type { PhotoAlignmentRequest } from "./photoAlignment.worker";

const resetCss = readFileSync("apps/web/src/app/reset.css", "utf8");

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

describe("JunctionPhoto", () => {
  it("shows the credited photo without a guessed path before image registration", () => {
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
    expect(html).not.toContain("data-photo-path");
    expect(html).toContain("© motocultrice · CC BY-SA 4.0 · Sep 2019");
    expect(html).not.toContain("<a ");
  });

  it("keeps a photo without lane evidence bare even after it loads", () => {
    const { container } = render(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 640, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 480, configurable: true });
    fireEvent.load(img);
    expect(container.querySelector("[data-photo-path]")).toBeNull();
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

  it.each([90, 300])(
    "keeps the panorama strip unconstrained by the image reset at heading %s",
    (heading) => {
      const reset = document.createElement("style");
      // jsdom does not apply cascade layers, so apply the reset's rules without its wrapper.
      reset.textContent = resetCss.replace(/@layer base\s*\{/, "").replace(/\}\s*$/, "");
      document.head.append(reset);
      try {
        const { container } = render(
          <JunctionPhoto
            image={{ ...flatImage, isPano: true, fovDeg: 360, heading }}
            objectUrl="blob:pano-1"
            point={point}
            geometry={geometry}
          />,
        );
        const images = container.querySelectorAll("[data-pano] img");
        expect(images).toHaveLength(heading === 300 ? 2 : 1);
        for (const image of images) {
          expect(getComputedStyle(image).maxWidth).toBe("none");
          expect(getComputedStyle(image).width).toBe("400%");
        }
      } finally {
        reset.remove();
      }
    },
  );

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

class RoadWorker {
  static jobs: RoadWorker[] = [];
  onmessage: ((event: { data: PhotoRoutePath | null }) => void) | null = null;
  onerror: (() => void) | null = null;
  request: PhotoAlignmentRequest | undefined;
  terminated = false;
  constructor() {
    RoadWorker.jobs.push(this);
  }
  postMessage(request: PhotoAlignmentRequest) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
  finish() {
    if (!this.request) throw new Error("Worker did not receive a request");
    const { geometry, point, image, pixels, exitLanes } = this.request;
    const alignment = alignPhotoRoad(geometry, point, image, pixels, exitLanes.laneCount);
    this.onmessage?.({
      data: alignment
        ? projectRoutePath(geometry, point, image, {
            alignment,
            exitLanes,
            aspectRatio: pixels.width / pixels.height,
          })
        : null,
    });
  }
}

function paintedRoadPixels() {
  const width = 640,
    height = 480,
    data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const road = y > 250 && x > 330 - 2.625 * (y - 250) && x < 330 + 4.375 * (y - 250);
      const paint =
        road &&
        [-2.625, -0.875, 0.875, 2.625, 4.375].some(
          (s) => Math.abs(x - 330 - s * (y - 250)) < Math.max(1, (y - 250) * 0.02),
        );
      data.set(
        paint ? [235, 235, 235, 255] : road ? [85, 85, 85, 255] : [60, 110, 55, 255],
        (y * width + x) * 4,
      );
    }
  return { width, height, data };
}
function loadPhoto(container: HTMLElement) {
  const img = container.querySelector("img") as HTMLImageElement;
  Object.defineProperty(img, "naturalWidth", { value: 640, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 480, configurable: true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage() {},
    getImageData: () => paintedRoadPixels(),
  } as never);
  fireEvent.load(img);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  RoadWorker.jobs = [];
});

describe("JunctionPhoto registration lifecycle", () => {
  const leftLanes = { laneCount: 4, activeLanes: [0, 1] };
  const image = { ...flatImage, fovDeg: 90 };
  it("draws two physical lane corridors after registration and crops them with the decoded image", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const { container } = render(
      <JunctionPhoto
        image={image}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    expect(container.querySelector("[data-photo-path]")).toBeNull();
    loadPhoto(container);
    expect(container.querySelector("[data-photo-path]")).toBeNull();
    act(() => RoadWorker.jobs[0].finish());
    const svg = container.querySelector("[data-photo-path]") as SVGSVGElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 75");
    expect(svg.getAttribute("data-lane-shift")).toBe("0.0");
    const ribbons = svg.querySelectorAll("polygon");
    expect(ribbons).toHaveLength(2);
    for (const ribbon of ribbons)
      for (const pair of String(ribbon.getAttribute("points")).split(" ")) {
        const [x, y] = pair.split(",").map(Number);
        expect(x * 6.4).toBeGreaterThan(330 - 2.625 * (y * 6.4 - 250) - 3);
        expect(x * 6.4).toBeLessThan(330 + 0.875 * (y * 6.4 - 250) + 3);
      }
  });
  it("never applies a delayed match to a replacement photo", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const { container, rerender } = render(
      <JunctionPhoto
        image={image}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    loadPhoto(container);
    const old = RoadWorker.jobs[0];
    rerender(
      <JunctionPhoto
        image={{ ...image, id: "photo-2" }}
        objectUrl="blob:photo-2"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    act(() => old.finish());
    expect(container.querySelector("[data-photo-path]")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:photo-2");
  });
  it("keeps the credited photo visible if canvas pixels cannot be read", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const { container } = render(
      <JunctionPhoto
        image={image}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage() {},
      getImageData() {
        throw new DOMException("tainted", "SecurityError");
      },
    } as never);
    fireEvent.load(img);
    expect(container.querySelector("[data-photo-path]")).toBeNull();
    expect(container.textContent).toContain("CC BY-SA 4.0");
  });
  it("registers an image that was already decoded when its ref attaches", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const prototype = HTMLImageElement.prototype;
    const properties = ["complete", "naturalWidth", "naturalHeight"] as const;
    const originals = properties.map((property) =>
      Object.getOwnPropertyDescriptor(prototype, property),
    );
    properties.forEach((property, index) => {
      Object.defineProperty(prototype, property, {
        configurable: true,
        get: () => [true, 640, 480][index],
      });
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage() {},
      getImageData: () => paintedRoadPixels(),
    } as never);
    try {
      const { container } = render(
        <JunctionPhoto
          image={image}
          objectUrl="blob:photo-1"
          point={point}
          geometry={geometry}
          exitLanes={leftLanes}
        />,
      );
      expect(RoadWorker.jobs).toHaveLength(1);
      act(() => RoadWorker.jobs[0].finish());
      expect(container.querySelectorAll("polygon")).toHaveLength(2);
    } finally {
      properties.forEach((property, index) => {
        const descriptor = originals[index];
        if (descriptor) Object.defineProperty(prototype, property, descriptor);
      });
    }
  });
  it("bounds both decoded dimensions before allocating a canvas for a tall photo", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const { container } = render(
      <JunctionPhoto
        image={image}
        objectUrl="blob:photo-1"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 500 });
    Object.defineProperty(img, "naturalHeight", { value: 4000 });
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
    } as never);
    fireEvent.load(img);
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0, 128, 1024);
    expect(RoadWorker.jobs[0].request?.pixels.height).toBe(1024);
  });
  it("ignores a load whose decoded source differs from the requested photo", () => {
    vi.stubGlobal("Worker", RoadWorker);
    const { container } = render(
      <JunctionPhoto
        image={image}
        objectUrl="blob:photo-2"
        point={point}
        geometry={geometry}
        exitLanes={leftLanes}
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    Object.defineProperty(img, "currentSrc", { value: "blob:photo-1" });
    Object.defineProperty(img, "naturalWidth", { value: 640 });
    Object.defineProperty(img, "naturalHeight", { value: 480 });
    const context = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
    fireEvent.load(img);
    expect(context).not.toHaveBeenCalled();
    expect(RoadWorker.jobs).toHaveLength(0);
  });
});
