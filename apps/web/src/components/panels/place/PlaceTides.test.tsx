import type { TidesResponse } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/useDateTimeFormat", () => ({
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
vi.mock("./useDataSourceAttribution", () => ({
  useDataSourceAttribution: () => undefined,
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
