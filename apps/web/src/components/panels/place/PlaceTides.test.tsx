import type { TidesResponse } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (value: Date) => value.toISOString().slice(11, 16),
  }),
}));
vi.mock("next-intl", () => ({
  useTranslations:
    () =>
    (key: string, values?: Record<string, unknown>): string =>
      values ? `${key}:${Object.values(values).join(",")}` : key,
}));

import { PlaceTidesContent } from "./PlaceTides";

const baseResponse: TidesResponse = {
  station: {
    id: "station-1",
    name: "Test Station",
    lat: 54.1,
    lng: 10.8,
    distanceKm: 1.2,
  },
  events: [],
  curve: [],
  datum: "MLLW",
  units: "english",
  timeZone: "lst_ldt",
  provider: {
    integrationId: "knowledge-tides-ioc",
    sourceId: "ioc-sealevel-monitoring",
  },
};

describe("PlaceTidesContent", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-05-18T00:00:00Z"));
  });

  it("renders upcoming predictions when no current observation is available", () => {
    render(
      <PlaceTidesContent
        data={{
          ...baseResponse,
          events: [
            { time: "2026-05-18T02:00:00Z", type: "H", valueFt: 3.4 },
            { time: "2026-05-18T08:00:00Z", type: "L", valueFt: 0.6 },
          ],
        }}
      />,
    );

    expect(screen.getByText("nextHigh")).toBeInTheDocument();
    expect(screen.getByText("nextLow")).toBeInTheDocument();
    expect(screen.queryByText("currentLevel")).not.toBeInTheDocument();
  });

  it.each([
    ["MLLW", "datumNoteMllw"],
    ["chart_datum", "datumNoteChartDatum"],
    ["gauge_zero", "datumNoteGaugeZero"],
    ["sensor_reference", "datumNoteSensorReference"],
  ] as const)("names the %s reference the heights are measured from", (datum, note) => {
    render(<PlaceTidesContent data={{ ...baseResponse, datum }} />);

    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.queryAllByText(/^datumNote/)).toHaveLength(1);
  });

  it("renders a current observation when no predictions are available", () => {
    render(
      <PlaceTidesContent
        data={{
          ...baseResponse,
          currentLevel: {
            time: "2026-05-18T00:00:00Z",
            valueFt: 2.1,
            quality: "v",
          },
        }}
      />,
    );

    expect(screen.getByText("currentLevel")).toBeInTheDocument();
    expect(screen.getByText("heightFt:2.1")).toBeInTheDocument();
    expect(screen.queryByText("nextHigh")).not.toBeInTheDocument();
    expect(screen.queryByText("nextLow")).not.toBeInTheDocument();
  });
});

it("projects the old prediction and fresh current-level receipts while excluding hidden tide fields", () => {
  render(
    <PlaceTidesContent
      data={{
        ...baseResponse,
        currentLevel: { time: "2026-05-18T00:00:00Z", valueFt: 2.1 },
        events: [{ time: "2026-05-18T02:00:00Z", type: "H", valueFt: 3.4 }],
        contributors: [{ sourceId: "blended", name: "Unselected blended credit" }],
        fieldContributors: {
          station: [],
          events: [{ sourceId: "same", name: "Prediction terms A" }],
          currentLevel: [{ sourceId: "same", name: "Observation terms B" }],
          curve: [{ sourceId: "hidden", name: "Hidden curve credit" }],
          met: [{ sourceId: "hidden", name: "Hidden met credit" }],
        },
      }}
    />,
  );
  expect(screen.getByText(/Prediction terms A/)).toBeInTheDocument();
  expect(screen.getByText(/Observation terms B/)).toBeInTheDocument();
  expect(
    screen.queryByText(/Hidden curve credit|Hidden met credit|Unselected blended credit/),
  ).not.toBeInTheDocument();
});
