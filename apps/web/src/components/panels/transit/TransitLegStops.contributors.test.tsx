import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (_key: string, values?: { count: number }) =>
    `${values?.count ?? ""} stops`,
}));
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (value: unknown) => value }),
}));
vi.mock("@openmapx/core", () => ({
  useVehicleJourney: () => ({
    data: {
      stops: [
        { stopId: "from", name: "From", contributors: [{ sourceId: "a", name: "A" }] },
        {
          stopId: "middle",
          name: "Middle",
          contributors: [{ sourceId: "b", name: "Count supplier B" }],
        },
        { stopId: "to", name: "To", contributors: [{ sourceId: "a", name: "A" }] },
        {
          stopId: "outside",
          name: "Outside",
          contributors: [{ sourceId: "c", name: "Outside supplier C" }],
        },
      ],
    },
  }),
}));
vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <div>{attributions.map((receipt) => receipt.name).join(";")}</div>
  ),
}));

import { TransitLegStops } from "./TransitLegStops";

it("credits a fetched count while children are collapsed and excludes other journey segments", () => {
  const markup = renderToStaticMarkup(
    <TransitLegStops tripId="trip" fromStopId="from" toStopId="to" />,
  );
  expect(markup).toContain("2 stops");
  expect(markup).toContain("Count supplier B");
  expect(markup).not.toContain("Outside supplier C");
});
