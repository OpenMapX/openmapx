import type { Attribution } from "@openmapx/mobility-core/attribution";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TransitDetailsView } from "./TransitDetailsView";

vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
  }),
}));

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    if (namespace === "directions" && key === "transitDuration") {
      return `${String(values?.duration ?? "")}`;
    }
    if (namespace === "directions" && key === "walkDuration") {
      return `${String(values?.duration ?? "")}`;
    }
    if (namespace === "directions" && key === "transfers") {
      return `${String(values?.count ?? 0)} transfer`;
    }
    if (namespace === "directions" && key === "walkDistance") {
      return `${String(values?.distance ?? "")} walk`;
    }
    if (namespace === "common" && key === "dataSources") return "Data sources";
    return key;
  },
}));

// importOriginal so the real tzOffsetLabel runs — a wholesale mock without it
// silently omits tzOffsetLabel, which passed only because destinationTimeZone
// defaulted to null in every existing spec here and short-circuited before
// tzOffsetLabel was ever called.
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    formatDistance: (d: number) => `${d} m`,
    formatDuration: (d: number) => `${d}s`,
    geocodeStopAsPlace: vi.fn().mockResolvedValue(null),
    PANEL: { PLACE_CARD: "PLACE_CARD" },
    usePlaceStore: () => ({ setSelectedPlace: vi.fn() }),
    useSidebarStore: Object.assign(() => ({}), {
      getState: () => ({ openDetail: vi.fn() }),
    }),
  };
});

vi.mock("@/components/panels/directions/TransitRouteView", () => ({
  LegBadge: () => <span data-testid="leg-badge" />,
  LegRemarks: () => null,
  LiveStopTime: ({ scheduledTime }: { scheduledTime: string }) => <span>{scheduledTime}</span>,
  TransitEmissionsBadge: () => null,
  TransitLiveBadge: () => null,
}));

vi.mock("@/components/panels/transit/LegAlerts", () => ({
  LegAlerts: () => null,
}));

vi.mock("@/components/panels/transit/RouteBadge", () => ({
  RouteBadge: ({ shortName }: { shortName?: string }) => <span>{shortName}</span>,
}));

vi.mock("@/components/panels/transit/TransitLegStops", () => ({
  TransitLegStops: () => null,
}));

vi.mock("@/components/panels/directions/TransitTransferSummary", () => ({
  TransitTransferSummary: () => null,
}));

vi.mock("@/components/panels/transit/TripDetailView", () => ({
  TripDetailView: () => null,
}));

vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({
    attributions,
    variant,
  }: {
    attributions: Array<{ sourceId: string; name: string }> | null | undefined;
    variant?: string;
  }) => {
    if (!attributions || attributions.length === 0) return null;
    return (
      <div data-testid={`attribution-strip-${variant ?? "inline"}`}>
        {attributions.map((a) => a.sourceId).join(",")}
      </div>
    );
  },
}));

vi.mock("@/lib/fareUtils", () => ({
  extractFareSummary: () => null,
  formatFare: () => "",
}));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ flyTo: vi.fn() }),
}));

vi.mock("@/integration-api/runtime/theme", () => ({
  BRAND: "#0f9d58",
}));

vi.mock("@/lib/transitOccupancy", () => ({
  OCCUPANCY_COLOR: {},
  OCCUPANCY_KEY: {},
}));

const ATTR_DELFI: Attribution = { sourceId: "de_DELFI", name: "DELFI" };
const ATTR_SBB: Attribution = { sourceId: "ch_SBB", name: "SBB" };

function makeItinerary(legAttrs: Array<Attribution[] | undefined>): TripItinerary {
  return {
    duration: 3600,
    startTime: "2026-05-21T08:00:00Z",
    endTime: "2026-05-21T09:00:00Z",
    transfers: legAttrs.length - 1,
    walkDistance: 0,
    legs: legAttrs.map((attributions, i) => ({
      mode: "rail" as const,
      startTime: "2026-05-21T08:00:00Z",
      endTime: "2026-05-21T09:00:00Z",
      from: {
        name: `From ${i}`,
        lat: 0,
        lng: 0,
        stopId: `ms:de_DELFI_${i}`,
      },
      to: {
        name: `To ${i}`,
        lat: 0,
        lng: 0,
        stopId: `ms:de_DELFI_${i + 1}`,
      },
      route: { shortName: "ICE", longName: "Express", color: "DF2027" },
      tripId: `trip-${i}`,
      geometry: {
        type: "LineString" as const,
        coordinates: [
          [0, 0],
          [0, 0],
        ] as [number, number][],
      },
      ...(attributions ? { attributions } : {}),
    })),
  };
}

describe("TransitDetailsView destination time zone", () => {
  it("renders the offset chip and the explanatory caption when the destination zone is set", () => {
    const itinerary = makeItinerary([undefined]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        destinationTimeZone="Asia/Tokyo"
        onBack={() => {}}
      />,
    );

    // itinerary.endTime is 2026-05-21T09:00:00Z -> UTC+9 in Asia/Tokyo.
    expect(markup).toContain("UTC+9");
    expect(markup).toContain("arrivalInDestinationTime");
  });

  it("renders neither the chip nor the caption when the destination zone is null", () => {
    const itinerary = makeItinerary([undefined]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        destinationTimeZone={null}
        onBack={() => {}}
      />,
    );

    expect(markup).not.toMatch(/\bUTC\b/);
    expect(markup).not.toContain("arrivalInDestinationTime");
  });

  it("renders neither the chip nor the caption when the zone id can't be resolved to an offset", () => {
    // A zone id the platform doesn't recognise (stale/unrecognised tzid):
    // tzOffsetLabel returns null, endTime already falls back to the viewer's
    // zone, and the caption must not claim a re-zoning that didn't happen —
    // it has to be gated on the resolved label, not the raw prop.
    const itinerary = makeItinerary([undefined]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        destinationTimeZone="Mars/Olympus"
        onBack={() => {}}
      />,
    );

    expect(markup).not.toMatch(/\bUTC\b/);
    expect(markup).not.toContain("arrivalInDestinationTime");
  });
});

describe("TransitDetailsView per-leg attribution", () => {
  it("renders an inline AttributionStrip when the leg's attribution differs from the trip union", () => {
    const itinerary = makeItinerary([[ATTR_DELFI], [ATTR_SBB]]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        attributions={[ATTR_DELFI, ATTR_SBB]}
        onBack={() => {}}
      />,
    );
    // Both per-leg strips render with their distinct source ids.
    expect(markup).toContain('data-testid="attribution-strip-inline"');
    expect(markup).toContain("de_DELFI");
    expect(markup).toContain("ch_SBB");
  });

  it("hides the per-leg strip when the leg's attribution equals the trip union", () => {
    const itinerary = makeItinerary([[ATTR_DELFI, ATTR_SBB]]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        attributions={[ATTR_DELFI, ATTR_SBB]}
        onBack={() => {}}
      />,
    );
    expect(markup).not.toContain('data-testid="attribution-strip-inline"');
  });

  it("hides the per-leg strip when the leg has no attributions", () => {
    const itinerary = makeItinerary([undefined]);
    const markup = renderToStaticMarkup(
      <TransitDetailsView
        itinerary={itinerary}
        originLabel="A"
        destinationLabel="B"
        attributions={[ATTR_DELFI]}
        onBack={() => {}}
      />,
    );
    expect(markup).not.toContain('data-testid="attribution-strip-inline"');
  });
});
