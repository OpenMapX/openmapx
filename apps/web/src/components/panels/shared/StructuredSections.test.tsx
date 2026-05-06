import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StructuredSections } from "./StructuredSections";

vi.mock("@/components/ui/HlsVideo", () => ({
  HlsVideo: ({ src }: { src: string }) => (
    <video src={src}>
      <track kind="captions" src="" srcLang="en" label="Captions" />
    </video>
  ),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) =>
    (
      ({
        externalMediaTitle: "External media",
        externalMediaBody: "Loads from the camera provider.",
        loadExternalMedia: "Load media",
      }) as Record<string, string>
    )[key] ?? key,
}));

vi.mock("@/lib/theme", () => ({
  TEAL: "#008080",
}));

describe("StructuredSections", () => {
  it("routes structured image sections through the backend image proxy", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Vehicle image",
            type: "image",
            imageUrl: "https://api.entur.io/mobility/assets/vehicle.png",
          },
        ]}
      />,
    );

    expect(markup).toContain(
      "http://localhost:3001/api/image-proxy?url=https%3A%2F%2Fapi.entur.io%2Fmobility%2Fassets%2Fvehicle.png",
    );
    expect(markup).not.toContain('src="https://api.entur.io');
  });

  it("does not load external embed URLs before the media gate is accepted", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Traffic camera",
            type: "embed",
            embedType: "video",
            embedUrl: "https://camera.example.test/live.m3u8",
            collapsed: false,
          },
        ]}
      />,
    );

    expect(markup).toContain("External media");
    expect(markup).toContain("Load media");
    expect(markup).not.toContain("https://camera.example.test/live.m3u8");
  });
});
