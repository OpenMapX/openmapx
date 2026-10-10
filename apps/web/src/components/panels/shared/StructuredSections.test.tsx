import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test";
import { StructuredSections } from "./StructuredSections";

vi.mock("@/components/ui/HlsVideo", () => ({
  HlsVideo: ({ src }: { src: string }) => (
    <video src={src}>
      <track kind="captions" src="" srcLang="en" label="Captions" />
    </video>
  ),
}));

vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
    relative: () => "5 minutes ago",
  }),
}));

const intl = vi.hoisted(() => ({ locale: "en" }));

vi.mock("next-intl", () => ({
  useLocale: () => intl.locale,
  useTranslations: () => (key: string) =>
    (
      ({
        externalMediaTitle: "External media",
        externalMediaBody: "Loads from the camera provider.",
        loadExternalMedia: "Load media",
      }) as Record<string, string>
    )[key] ?? key,
}));

vi.mock("@/integration-api/runtime/theme", () => ({
  BRAND: "#008080",
}));

describe("StructuredSections pricing plans", () => {
  const plans = (locale: string) => {
    intl.locale = locale;
    try {
      return renderToStaticMarkup(
        <StructuredSections
          sections={[
            {
              title: "Pricing",
              type: "pricing",
              pricingPlans: [{ name: "", currency: "EUR", unlockFee: 1, perKm: 0.19, perHour: 12 }],
            },
          ]}
        />,
      );
    } finally {
      intl.locale = "en";
    }
  };

  it("writes plan prices in the reader's locale", () => {
    const en = plans("en");
    expect(en).toContain("€1.00");
    expect(en).toContain("€0.19/km");
    expect(en).toContain("€12.00/h");

    const de = plans("de");
    expect(de).toContain("1,00 €");
    expect(de).toContain("0,19 €/km");
    expect(de).toContain("12,00 €/h");
    expect(de).not.toContain("1.00 €");
  });
});

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
            rows: [["CCS (Type 2)", "50 kW", "DC", 2, "Available", "available"]],
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
            rows: [["CCS (Type 2)", "50 kW", "DC", 2, "Available", "available"]],
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
            rows: [["CCS (Type 2)", "50 kW", "DC", 2, "Available", "available"]],
            sectionIcon: "bolt",
          },
        ]}
      />,
    );

    expect(markup).toContain("2 of 4 available");
    expect(markup).not.toContain("5 minutes ago");
  });

  it("colours a connector status by its kind cell, not by the words of the status", () => {
    const render = (status: string, kind: string) =>
      renderToStaticMarkup(
        <StructuredSections
          sections={[
            {
              title: "Connectors",
              type: "table",
              rowLayout: "connector",
              rows: [["CCS (Type 2)", "150 kW", "DC", 1, status, kind]],
              sectionIcon: "bolt",
            },
          ]}
        />,
      );
    // The status is the row's last caption; its generated class carries the colour.
    const statusClass = (markup: string) =>
      [...markup.matchAll(/<span class="([^"]+)">/g)].at(-1)?.[1];

    const available = statusClass(render("Verfügbar", "available"));
    const out = statusClass(render("Not operational", "out"));
    const unknown = statusClass(render("", "unknown"));

    expect(new Set([available, out, unknown]).size).toBe(3);
    expect(statusClass(render("Operational, available", "unknown"))).toBe(unknown);
    expect(statusClass(render("Not available", "out"))).toBe(out);
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

describe("StructuredSections refreshing stills", () => {
  const STILL = "https://weathercam.digitraffic.fi/C0150201.jpg";
  const PROXIED = `http://localhost:3001/api/image-proxy?url=${encodeURIComponent(STILL)}`;

  /**
   * Mounts one image section and hands back a switch for whether it is on
   * screen. Only observers watching an element still in the document hear
   * the switch, as a real observer of a removed element hears nothing.
   */
  function mountStill(refreshSec?: number, imageUrl = STILL) {
    const observers = new Set<{ notify: IntersectionObserverCallback; targets: Element[] }>();
    class Observer {
      private readonly entry: { notify: IntersectionObserverCallback; targets: Element[] };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { notify: callback, targets: [] };
        observers.add(this.entry);
      }
      observe(element: Element) {
        this.entry.targets.push(element);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.entry);
      }
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const sections = (url: string) => [
      { title: "Helsinkiin", type: "image" as const, imageUrl: url, refreshSec },
    ];
    const view = render(<StructuredSections sections={sections(imageUrl)} />);
    const onScreen = (isIntersecting: boolean) =>
      act(() => {
        for (const { notify, targets } of observers) {
          const live = targets.filter((target) => document.contains(target));
          if (live.length === 0) continue;
          notify(
            live.map((target) => ({ target, isIntersecting })) as IntersectionObserverEntry[],
            {} as IntersectionObserver,
          );
        }
      });
    const img = () => screen.queryByRole("img");
    const src = () => img()?.getAttribute("src") ?? null;
    const showUrl = (url: string) => view.rerender(<StructuredSections sections={sections(url)} />);
    return { onScreen, src, img, showUrl };
  }

  async function advance(seconds: number) {
    await act(async () => vi.advanceTimersByTimeAsync(seconds * 1000));
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("re-requests the still every refreshSec while the section is on screen", async () => {
    const { onScreen, src } = mountStill(60);
    onScreen(true);
    expect(src()).toBe(PROXIED);

    await advance(59);
    expect(src()).toBe(PROXIED);
    await advance(1);
    const first = src();
    expect(first).not.toBe(PROXIED);
    expect(first?.startsWith(`${PROXIED}&`)).toBe(true);

    await advance(60);
    expect(src()).not.toBe(first);
  });

  it("never refreshes while the section is off screen", async () => {
    const { onScreen, src } = mountStill(60);

    await advance(180);
    expect(src()).toBe(PROXIED);

    onScreen(true);
    await advance(60);
    const shown = src();
    expect(shown).not.toBe(PROXIED);

    onScreen(false);
    await advance(300);
    expect(src()).toBe(shown);
  });

  it("never refreshes while the page is hidden", async () => {
    const { onScreen, src } = mountStill(60);
    onScreen(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await advance(300);
    expect(src()).toBe(PROXIED);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60);
    expect(src()).not.toBe(PROXIED);
  });

  it("refreshes at most every 30 seconds", async () => {
    const { onScreen, src } = mountStill(5);
    onScreen(true);

    await advance(29);
    expect(src()).toBe(PROXIED);
    await advance(1);
    expect(src()).not.toBe(PROXIED);
  });

  it("leaves a still without refreshSec alone", async () => {
    const { onScreen, src } = mountStill();
    onScreen(true);

    await advance(600);
    expect(src()).toBe(PROXIED);
  });

  it("refreshes a still whose frame mounts after the first render", async () => {
    const { onScreen, src, img, showUrl } = mountStill(60);
    // The first still fails before anything loaded, so the section renders nothing.
    fireEvent.error(img() as HTMLElement);
    expect(img()).toBeNull();

    const next = "https://weathercam.digitraffic.fi/C0150202.jpg";
    const proxiedNext = `http://localhost:3001/api/image-proxy?url=${encodeURIComponent(next)}`;
    showUrl(next);
    expect(src()).toBe(proxiedNext);

    onScreen(true);
    await advance(60);
    expect(src()).not.toBe(proxiedNext);
    expect(src()?.startsWith(`${proxiedNext}&`)).toBe(true);
  });

  it("keeps the last loaded still when a refresh fails; only a first failure hides it", async () => {
    const { onScreen, src, img } = mountStill(60);
    onScreen(true);

    await advance(60);
    const loaded = src();
    fireEvent.load(img() as HTMLElement);

    await advance(60);
    expect(src()).not.toBe(loaded);
    fireEvent.error(img() as HTMLElement);
    expect(src()).toBe(loaded);

    await advance(60);
    expect(src()).not.toBe(loaded);
  });

  it("hides the section when the first still fails", () => {
    const { img } = mountStill(60);

    fireEvent.error(img() as HTMLElement);

    expect(img()).toBeNull();
  });
});
