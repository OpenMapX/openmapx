import type { StreetLevelImage } from "@openmapx/core";
import { act, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PreparedJunctionPhoto } from "@/lib/navigation/prepareJunctionPhoto";
import { JunctionPhoto } from "./JunctionPhoto";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    key === "junctionPhotoCaption"
      ? `© ${values?.author} · ${values?.license} · ${values?.date}`
      : `© ${values?.author} · ${values?.license}`,
  useLocale: () => "en",
}));
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

const prepared: PreparedJunctionPhoto = {
  key: "test",
  width: 640,
  height: 480,
  aspectRatio: 4 / 3,
  registration: {
    version: "observed-boundaries-v3",
    scene: "relevant",
    alignment: null,
    evidence: { roadFraction: 1, markingFraction: 1, observedBoundaries: 0 },
  },
  path: { points: [], ribbons: [], visible: false, headRotateDeg: 0, laneShiftMeters: 0 },
  preparationMs: 10,
};
const ribbon = [
  { xPercent: 98, yPercent: 60, widthPercent: 1, distanceMeters: 8 },
  { xPercent: 99, yPercent: 55, widthPercent: 0.5, distanceMeters: 30 },
];
describe("prepared junction photo", () => {
  it("shows a decoded bare photo with complete attribution and a non-truncating capture month", () => {
    const { container } = render(
      <JunctionPhoto image={flatImage} objectUrl="blob:photo" prepared={prepared} />,
    );
    expect(container.querySelector("[data-capture-month]")?.textContent).toBe("Sep 2019");
    expect(container.querySelector("[title]")?.getAttribute("title")).toBe(
      "© motocultrice · CC BY-SA 4.0 · Sep 2019",
    );
    expect(container.querySelector("[data-photo-path]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
  it.each([90, 300])("keeps the full panorama strip unconstrained at heading %s", (heading) => {
    const { container } = render(
      <JunctionPhoto
        image={{ ...flatImage, isPano: true, heading }}
        objectUrl="blob:pano"
        prepared={{
          ...prepared,
          width: 2048,
          height: 1024,
          aspectRatio: 2,
          path: { ...prepared.path, crop: { startDeg: 45, spanDeg: 90 } },
        }}
      />,
    );
    const images = container.querySelectorAll("[data-pano] img");
    expect(images.length).toBe(heading === 300 ? 2 : 1);
    for (const img of images) {
      expect(getComputedStyle(img).maxWidth).toBe("none");
      expect(getComputedStyle(img).width).toBe("400%");
    }
  });
  it("repeats the overlay together with both image copies at a panorama seam", () => {
    const { container } = render(
      <JunctionPhoto
        image={{ ...flatImage, isPano: true, heading: 300 }}
        objectUrl="blob:pano"
        prepared={{
          ...prepared,
          aspectRatio: 2,
          path: {
            ...prepared.path,
            crop: { startDeg: 45, spanDeg: 90 },
            visible: true,
            points: ribbon,
            ribbons: [ribbon],
          },
        }}
      />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(2);
    const overlays = container.querySelectorAll("[data-photo-path]");
    expect(overlays).toHaveLength(2);
    expect(overlays[0].querySelector("polygon")?.getAttribute("points")).toBe(
      overlays[1].querySelector("polygon")?.getAttribute("points"),
    );
  });
  it("collapses a failed image completely and permits a replacement", () => {
    const { container, rerender } = render(
      <JunctionPhoto image={flatImage} objectUrl="blob:bad" prepared={prepared} />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("[data-testid=junction-photo]")).toBeNull();
    act(() =>
      rerender(
        <JunctionPhoto image={flatImage} objectUrl="blob:replacement" prepared={prepared} />,
      ),
    );
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:replacement");
  });
  it("uses source-image aspect for both the cover crop and overlay", () => {
    const html = renderToStaticMarkup(
      <JunctionPhoto
        image={flatImage}
        objectUrl="blob:photo"
        prepared={{
          ...prepared,
          aspectRatio: 2,
          path: { ...prepared.path, visible: true, points: ribbon, ribbons: [ribbon] },
        }}
      />,
    );
    expect(html).toContain('viewBox="0 0 100 50"');
    expect(html).toContain('preserveAspectRatio="xMidYMid slice"');
    const { container } = render(
      <JunctionPhoto image={flatImage} objectUrl="blob:photo" prepared={prepared} />,
    );
    expect(getComputedStyle(container.querySelector("img")!).objectFit).toBe("cover");
  });
});
