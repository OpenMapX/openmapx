import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TripDetailView } from "./TripDetailView";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: (namespace: string) => (key: string) => {
    if (namespace === "common") {
      return (
        {
          back: "Back",
          data: "Data",
          retry: "Retry",
        }[key] ?? key
      );
    }
    return (
      {
        airConditioning: "Air conditioning",
        bikeSpaces: "Bike spaces",
        firstClassSeats: "First class seats",
        formation: "Formation",
        formationShort: "Formation short",
        lowFloorAccess: "Low-floor access",
        occupancy: "Occupancy",
        occupancyForecast: "Forecast",
        operator: "Operator",
        operatorCode: "Operator code",
        platform: "Platform",
        seats: "Seats",
        secondClassSeats: "Second class seats",
        stops: "Stops",
        toilet: "Toilet",
        trainNumber: "Train number",
        vehicle: "Vehicle",
        vehicleCount: "Vehicle count",
        wheelchairSpaces: "Wheelchair spaces",
      }[key] ?? key
    );
  },
}));

vi.mock("@openmapx/core", () => ({
  MODE_COLORS: { rail: "#0055aa" },
  resolveProvider: (
    providers: Array<{ id: string; label: string; url?: string; license?: string }>,
    providerId: string,
  ) =>
    providers.find((provider) => provider.id === providerId) ?? {
      id: providerId,
      label: providerId,
    },
  useProviders: () => ({
    data: [
      {
        id: "otdch",
        label: "OpenTransportData Switzerland",
        url: "https://opentransportdata.swiss",
        license: "Terms",
      },
    ],
  }),
  useRouteAlerts: () => ({ data: [] }),
  useVehicleJourney: () => ({
    data: {
      serviceInfo: {
        operatorName: "Swiss Federal Railways SBB",
        trainNumber: "IC6-419",
        operatorParticipantRef: "SBBP",
        occupancySource: "opentransportdata.swiss/occupancy-forecast",
      },
      formationDetails: {
        shortFormation: "A-B",
        vehicleCount: 2,
        seats: 520,
        operatorCode: "SBBP",
        vehicles: [
          {
            id: "vehicle-1",
            typeCode: "IC2000",
            order: 1,
            seatsFirstClass: 80,
            seatsSecondClass: 180,
            bikeSpaces: 4,
            wheelchairSpaces: 2,
            hasAirConditioning: true,
            hasLowFloorAccess: true,
            hasToilet: true,
          },
        ],
      },
      stops: [
        { name: "Bern", scheduledDeparture: "2025-02-03T14:47:00Z", platform: "10" },
        { name: "Thun", scheduledArrival: "2025-02-03T15:20:00Z", platform: "3" },
      ],
    },
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@/lib/formatTime", () => ({
  formatTime: (value: string) => value.slice(11, 16),
}));

vi.mock("@/lib/theme", () => ({
  TEAL: "#008080",
}));

vi.mock("@/lib/transitOccupancy", () => ({
  OCCUPANCY_COLOR: {
    medium: "#ff9800",
  },
  OCCUPANCY_KEY: {
    medium: "occupancyMedium",
  },
}));

vi.mock("./AlertsBanner", () => ({
  AlertsBanner: () => <div>Alerts</div>,
}));

vi.mock("./RemarkChip", () => ({
  RemarkChip: ({ remark }: { remark: { text: string } }) => <div>{remark.text}</div>,
}));

vi.mock("./RouteBadge", () => ({
  RouteBadge: ({ shortName }: { shortName?: string }) => <div>{shortName}</div>,
}));

describe("TripDetailView", () => {
  it("renders Swiss service metadata and train formation details", () => {
    const markup = renderToStaticMarkup(
      <TripDetailView
        departure={{
          tripId: "otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA",
          tripIds: ["otdch:2025-02-03|ojp-92-12-_-j25-1-419-TA"],
          providers: ["otdch"],
          route: {
            id: "otdch:ojp:91006:H",
            shortName: "IC6",
            longName: "Thun",
            mode: "rail",
            color: "DF2027",
          },
          headsign: "Thun",
          scheduledAt: "2025-02-03T14:47:00Z",
          platform: "10",
          remarks: [{ text: "Bike spaces limited", type: "info" }],
        }}
        onBack={() => {}}
      />,
    );

    expect(markup).toContain("Swiss Federal Railways SBB");
    expect(markup).toContain("IC6-419");
    expect(markup).toContain("SBBP");
    expect(markup).toContain("Forecast");
    expect(markup).toContain("Formation");
    expect(markup).toContain("A-B");
    expect(markup).toContain("IC2000 #1");
    expect(markup).toContain("80 First class seats");
    expect(markup).toContain("180 Second class seats");
    expect(markup).toContain("4 Bike spaces");
    expect(markup).toContain("2 Wheelchair spaces");
    expect(markup).toContain("Air conditioning");
    expect(markup).toContain("Low-floor access");
    expect(markup).toContain("Toilet");
    expect(markup).toContain("Bern");
    expect(markup).toContain("Thun");
    expect(markup).toContain("OpenTransportData Switzerland");
  });
});
