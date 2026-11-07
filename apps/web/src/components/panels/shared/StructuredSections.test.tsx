import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@/test";
import { StructuredSections } from "./StructuredSections";

vi.mock("@/components/ui/HlsVideo", () => ({
  HlsVideo: ({ src }: { src: string }) => (
    <video src={src}>
      <track kind="captions" src="https://player.test/captions" srcLang="en" label="Captions" />
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
    const color = (status: string, kind: string) => {
      const view = render(
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
      const actual = getComputedStyle(screen.getByText(status)).color;
      view.unmount();
      return actual;
    };
    const available = color("Verfügbar", "available"),
      out = color("Not operational", "out"),
      unknown = color("Unknown", "unknown");
    expect(new Set([available, out, unknown]).size).toBe(3);
    expect(color("Operational, available", "unknown")).toBe(unknown);
    expect(color("Not available", "out")).toBe(out);
  });

  it("renders a pricing-layout table as label + conditions caption with the price alongside", () => {
    render(
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

    const first = screen.getByText("CCS · DC · 60 kW"),
      second = screen.getByText("Type 2 · AC · 11 kW"),
      condition = screen.getByText("≥1 h");
    expect(first.nextElementSibling).toBeNull();
    expect(condition.previousElementSibling).toBe(second);
    const price = screen.getByText("€0.46/kWh"),
      row = first.parentElement?.parentElement;
    expect(row?.contains(price)).toBe(true);
    expect(first.parentElement?.contains(price)).toBe(false);
    expect(getComputedStyle(row as HTMLElement).display).toBe("flex");
    expect(getComputedStyle(row as HTMLElement).justifyContent).toBe("space-between");
    expect(screen.getByText("€0.13/min")).toBeVisible();
  });

  it("renders a section's links as clickable anchors to the given urls", () => {
    const markup = renderToStaticMarkup(
      <StructuredSections
        sections={[
          {
            title: "Pricing",
            type: "table",
            rows: [
              ["Energy", "€0.59/kWh"],
              ["Parking", "€2.00/h parking"],
            ],
            caption: "Direct payment price at this charger — your provider may charge differently.",
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
    expect(markup).toContain("€0.59/kWh");
    expect(markup).toContain("€2.00/h parking");
    expect(markup).toContain(
      "Direct payment price at this charger — your provider may charge differently.",
    );
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

  it.each([
    "javascript:alert(1)",
    "/local/thing",
    new URL("/local/thing", window.location.href).href,
  ])("rejects invalid and same-origin embed URLs before offering consent: %s", (embedUrl) => {
    const { container } = render(
      <StructuredSections
        sections={[
          {
            title: "Untrusted camera",
            type: "embed",
            embedType: "iframe",
            embedUrl,
            collapsed: false,
          },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: "Load media" })).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
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
});

it("keeps image-specific branding adjacent to its own image even in a mixed detail", () => {
  render(
    <StructuredSections
      sections={[
        {
          title: "Windy view",
          type: "image",
          imageUrl: "https://image.test/frame.jpg",
          contributors: [
            {
              sourceId: "windy",
              name: "Windy",
              licensing: {
                version: 1,
                bindings: [
                  {
                    scope: "service",
                    subject: "API",
                    license: { kind: "unknown" },
                    attribution: {
                      placement: "visible",
                      surfaces: ["image"],
                      basis: "provider-terms",
                      reviewedAt: "2026-10-14",
                      evidenceUrls: ["https://api.windy.com/terms"],
                      reason: "Adjacent continuous courtesy",
                      compactText:
                        'Webcams provided by <a href="https://windy.com/">windy.com</a> — <a href="https://windy.com/webcams/add">add a webcam</a>',
                      prominence: "normal",
                    },
                  },
                ],
              },
            },
          ],
        },
        { title: "Other image", type: "image", imageUrl: "https://image.test/other.jpg" },
      ]}
    />,
  );
  const ownFrame = screen.getByRole("img", { name: "Windy view" }).parentElement as HTMLElement;
  const otherFrame = screen.getByRole("img", { name: "Other image" }).parentElement as HTMLElement;
  expect(within(ownFrame).getByRole("link", { name: "add a webcam" })).toBeVisible();
  expect(within(otherFrame).queryByRole("link", { name: "add a webcam" })).toBeNull();
});

it.each(["video", "iframe"] as const)(
  "keeps image-surface service credit beside a consented %s",
  (embedType) => {
    const { container } = render(
      <StructuredSections
        sections={[
          {
            title: "Camera player",
            type: "embed",
            collapsed: false,
            embedType,
            embedUrl: "https://player.test/embed",
            contributors: [
              {
                sourceId: "camera-service",
                name: "Provider",
                licensing: {
                  version: 1,
                  bindings: [
                    {
                      scope: "service",
                      subject: "API",
                      license: { kind: "unknown" },
                      attribution: {
                        placement: "visible",
                        surfaces: ["image"],
                        basis: "provider-terms",
                        reviewedAt: "2026-10-14",
                        evidenceUrls: ["https://player.test/terms"],
                        reason: "Adjacent provider",
                        compactText: "Required player service credit",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ]}
      />,
    );
    expect(screen.queryByText("Required player service credit")).toBeNull();
    expect(screen.getByText("External media")).toBeVisible();
    expect(container.innerHTML).not.toContain("https://player.test/embed");
    expect(container.querySelector("video,iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load media" }));
    const player = container.querySelector(embedType === "video" ? "video" : "iframe");
    expect(player).toHaveAttribute("src", "https://player.test/embed");
    if (embedType === "iframe")
      expect(player).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(screen.getByText("Required player service credit")).toBeVisible();
  },
);

it.each(["image", "video", "iframe"] as const)(
  "uses one disclosure for optional %s provenance",
  (kind) => {
    const contributors = [
      {
        sourceId: "optional",
        name: "Optional image source",
        licensing: licensingFromDeclaration(
          "CC BY-SA 4.0",
          "https://creativecommons.org/licenses/by-sa/4.0/",
        ),
      },
    ];
    render(
      <StructuredSections
        sections={[
          kind === "image"
            ? {
                title: "Picture",
                type: "image",
                imageUrl: "https://image.test/frame",
                contributors,
              }
            : {
                title: "Player",
                type: "embed",
                collapsed: false,
                embedType: kind,
                embedUrl: "https://player.test/embed",
                contributors,
              },
        ]}
      />,
    );
    if (kind !== "image") fireEvent.click(screen.getByRole("button", { name: "Load media" }));
    expect(screen.getAllByRole("button", { name: "attributions" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "showMore" })).toBeNull();
  },
);
