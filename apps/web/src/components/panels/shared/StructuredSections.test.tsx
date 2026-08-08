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

vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
    relative: () => "5 minutes ago",
  }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
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
  BRAND: "#008080",
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

  it("renders the section caption beneath the header", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Connectors",
            caption: "2 of 4 available",
            type: "table",
            columns: ["Type", "Power", "Current", "Qty", "Status"],
            rows: [["CCS", "50 kW", "DC", 2, "operational"]],
            sectionIcon: "bolt",
          },
        ]}
      />,
    );

    expect(markup).toContain("2 of 4 available");
  });

  it("appends a relative-time suffix when the caption has a captionTimestamp", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Connectors",
            caption: "2 of 4 available",
            captionTimestamp: "2026-07-20T10:00:00Z",
            type: "table",
            columns: ["Type", "Power", "Current", "Qty", "Status"],
            rows: [["CCS", "50 kW", "DC", 2, "operational"]],
            sectionIcon: "bolt",
          },
        ]}
      />,
    );

    expect(markup).toContain("2 of 4 available");
    expect(markup).toContain("5 minutes ago");
  });

  it("renders the caption without a relative-time suffix when there is no captionTimestamp", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Connectors",
            caption: "2 of 4 available",
            type: "table",
            columns: ["Type", "Power", "Current", "Qty", "Status"],
            rows: [["CCS", "50 kW", "DC", 2, "operational"]],
            sectionIcon: "bolt",
          },
        ]}
      />,
    );

    expect(markup).toContain("2 of 4 available");
    expect(markup).not.toContain("5 minutes ago");
  });

  it("renders a structured pricing table with formatted prices and a direct-price caption", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            caption: "Direct payment price at this charger — your provider may charge differently.",
            type: "table",
            rows: [
              ["Energy", "€0.59/kWh"],
              ["Parking", "€2.00/h parking"],
            ],
            sectionIcon: "payments",
          },
        ]}
      />,
    );

    expect(markup).toContain("€0.59/kWh");
    expect(markup).toContain("€2.00/h parking");
    expect(markup).toContain(
      "Direct payment price at this charger — your provider may charge differently.",
    );
  });

  it("renders a pricing-layout table as label + conditions caption with the price alongside", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            type: "table",
            rowLayout: "pricing",
            rows: [
              ["CCS · DC · 60 kW", "€0.46/kWh", ""],
              ["Type 2 · AC · 11 kW", "€0.13/min", "≥1 h"],
            ],
            sectionIcon: "payments",
          },
        ]}
      />,
    );

    expect(markup).toContain("CCS · DC · 60 kW");
    expect(markup).toContain("€0.46/kWh");
    expect(markup).toContain("Type 2 · AC · 11 kW");
    expect(markup).toContain("≥1 h");
  });

  it("does not render a pricing row's conditions caption when the cell is empty", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            type: "table",
            rowLayout: "pricing",
            rows: [["Energy", "€0.46/kWh", ""]],
            sectionIcon: "payments",
          },
        ]}
      />,
    );

    expect(markup).not.toContain("MuiTypography-caption");
  });

  it("renders a section's links as clickable anchors to the given urls", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            type: "table",
            rows: [["Energy", "€0.48/kWh"]],
            sectionIcon: "payments",
            links: [
              { label: "Night rate applies 00:00-07:00", url: "https://example.org/tariffs/1" },
              { label: "View tariff details", url: "https://example.org/tariffs/2" },
            ],
          },
        ]}
      />,
    );

    expect(markup).toContain('href="https://example.org/tariffs/1"');
    expect(markup).toContain('href="https://example.org/tariffs/2"');
    expect(markup).toContain("Night rate applies 00:00-07:00");
    expect(markup).toContain("View tariff details");
    expect(markup).toContain('target="_blank"');
  });

  it("renders a link entry without a url as plain text, not an anchor", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            type: "table",
            rows: [["Energy", "€0.48/kWh"]],
            sectionIcon: "payments",
            links: [{ label: "Ask your provider for terms" }],
          },
        ]}
      />,
    );

    expect(markup).toContain("Ask your provider for terms");
    expect(markup).not.toContain("<a ");
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

  it("drops non-http embed URLs instead of framing them", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Untrusted camera",
            type: "embed",
            embedType: "iframe",
            embedUrl: "javascript:alert(1)",
            collapsed: false,
          },
        ]}
      />,
    );

    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("javascript:");
  });

  it("drops same-origin relative embed URLs instead of framing them", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Local camera",
            type: "embed",
            embedType: "iframe",
            embedUrl: "/local/thing",
            collapsed: false,
          },
        ]}
      />,
    );

    expect(markup).not.toContain("<iframe");
  });

  it("requires consent before rendering an external iframe", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "External camera",
            type: "embed",
            embedType: "iframe",
            embedUrl: "https://camera.example.test/player",
            collapsed: false,
          },
        ]}
      />,
    );

    expect(markup).toContain("Load media");
    expect(markup).not.toContain("<iframe");
  });
});
