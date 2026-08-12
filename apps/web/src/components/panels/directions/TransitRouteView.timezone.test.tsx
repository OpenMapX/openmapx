import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TransitItineraryCard } from "./TransitRouteView";
import { SAMPLE_TRANSIT_ITINERARY } from "./TransitRouteView.fixtures";

// A deterministic 24h clock, timezone-aware exactly like the real
// useDateTimeFormat -> formatClockTime, but pinned off locale/settings-store
// nondeterminism so the assertion below ("18:00") doesn't depend on the
// user's time-format preference or the test runner's default locale.
vi.mock("@/lib/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (value: string | number | Date, opts?: { timeZone?: string }) =>
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        ...(opts?.timeZone ? { timeZone: opts.timeZone } : {}),
      }).format(new Date(value)),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
  }),
}));

vi.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === "directions" && key === "transfers") {
      return `${String(values?.count ?? 0)} transfer`;
    }
    if (namespace === "directions" && key === "walkDistance") {
      return `${String(values?.distance ?? "")} walk`;
    }
    if (namespace === "common" && key === "details") return "Details";
    return key;
  },
  useLocale: () => "en",
}));

// Real tzOffsetLabel (via importOriginal) so `UTC+9` reflects the actual
// Asia/Tokyo offset math rather than a hardcoded stand-in; only the hooks
// that need a live store/query-client are faked.
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    formatDistance: (distance: number) => `${distance} m`,
    formatDuration: (duration: number) => `${duration}s`,
    useVehicleJourney: () => ({ data: null }),
    useRefreshTransitItinerary: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useSettingsStore: (sel: (s: { units: string }) => unknown) => sel({ units: "metric" }),
    useNavigationStore: Object.assign(
      (sel: (s: { startTransitNavigation: () => void }) => unknown) =>
        sel({ startTransitNavigation: () => {} }),
      { getState: () => ({ startTransitNavigation: () => {} }) },
    ),
  };
});

vi.mock("@/components/panels/transit/RouteBadge", () => ({
  RouteBadge: ({ shortName }: { shortName: string }) => <span>{shortName}</span>,
}));

vi.mock("@/components/panels/transit/RemarkChip", () => ({
  RemarkChip: () => null,
}));

vi.mock("@/lib/fareUtils", () => ({
  extractFareSummary: () => null,
  formatFare: () => "",
}));

vi.mock("@/lib/theme", () => ({
  BRAND: "#0f9d58",
  BRAND_HEX: "#0f9d58",
}));

vi.mock("@/lib/transitOccupancy", () => ({
  OCCUPANCY_COLOR: { low: "#0f9d58", medium: "#fbbc04", high: "#f57c00", overcrowded: "#d93025" },
  OCCUPANCY_KEY: { low: "low", medium: "medium", high: "high", overcrowded: "overcrowded" },
}));

const itinerary = {
  ...SAMPLE_TRANSIT_ITINERARY,
  startTime: "2026-07-15T00:00:00Z",
  endTime: "2026-07-15T09:00:00Z",
};

describe("TransitItineraryCard destination time zone", () => {
  it("renders the arrival in the destination zone with an offset chip when the zones differ", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itinerary}
        active={false}
        destinationTimeZone="Asia/Tokyo"
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );

    expect(markup).toContain("18:00");
    expect(markup).toContain("UTC+9");
  });

  it("renders no offset chip when the destination zone is null", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itinerary}
        active={false}
        destinationTimeZone={null}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );

    // Also catches a bare "UTC" chip rendering at a zero offset difference —
    // not just a signed "UTC+"/"UTC-" one.
    expect(markup).not.toMatch(/\bUTC\b/);
  });
});

describe("TransitItineraryCard origin time zone", () => {
  it("renders the departure in the origin zone, with no offset chip, when it differs from the viewer's", () => {
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={itinerary}
        active={false}
        originTimeZone="Asia/Tokyo"
        destinationTimeZone={null}
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );

    // 2026-07-15T00:00:00Z is 09:00 in Asia/Tokyo (UTC+9) — the departure
    // board reads in the zone you're standing in, so no "UTC+9" chip renders
    // next to it even though the destination one does when it applies.
    expect(markup).toContain("09:00");
    expect(markup).not.toMatch(/\bUTC\b/);
  });

  it("renders the whole pair self-consistently when a viewer's start and end both differ from their own zone", () => {
    // The scenario the crash/consistency fix targets: a Berlin viewer
    // planning Tokyo -> Beijing. Before the fix, startTime rendered in the
    // viewer's zone while endTime rendered in the destination's, producing a
    // span that didn't match the itinerary's actual duration.
    const crossZoneItinerary = {
      ...SAMPLE_TRANSIT_ITINERARY,
      startTime: "2026-07-15T00:00:00Z", // 09:00 JST
      endTime: "2026-07-15T04:30:00Z", // 12:30 CST
    };
    const markup = renderToStaticMarkup(
      <TransitItineraryCard
        itinerary={crossZoneItinerary}
        active={false}
        originTimeZone="Asia/Tokyo"
        destinationTimeZone="Asia/Shanghai"
        onSelect={() => {}}
        onDetails={() => {}}
      />,
    );

    expect(markup).toContain("09:00");
    expect(markup).toContain("12:30");
    expect(markup).toContain("UTC+8");
  });
});
