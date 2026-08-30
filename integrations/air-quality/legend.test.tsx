import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, userEvent, within } from "@/test";

import { useAirQualityStore } from "./store";

const visibility = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useOverlayVisibilitySetter: () => visibility,
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const { AirQualityLegend, CONCENTRATION_LEVELS } = await import("./legend");

beforeEach(() => {
  visibility.mockClear();
  useAirQualityStore.getState().reset();
  useAirQualityStore.getState().openPanel();
});

describe("canonical air-quality legend", () => {
  it("renders an accessible visibility switch and raw numeric Cividis legend", async () => {
    render(<AirQualityLegend />);

    const toggle = screen.getByRole("switch", { name: "airQualityMap.toggleOverlay" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(visibility).toHaveBeenCalledWith(false);

    const scale = screen.getByTestId("air-quality-concentration-scale");
    for (const level of CONCENTRATION_LEVELS) {
      expect(within(scale).getByText(level.label)).toBeVisible();
      expect(within(scale).getByTestId(`air-quality-level-${level.label}`)).toHaveAttribute(
        "data-color",
        level.color,
      );
    }
    expect(scale).toHaveTextContent("airQualityMap.unit.ugm3");
    expect(scale).not.toHaveTextContent("Good");
    expect(scale).not.toHaveTextContent("AQI");
  });

  it("offers keyboard-native mode and pollutant controls without enabling the future raster", async () => {
    render(<AirQualityLegend />);
    const mode = screen.getByRole("combobox", { name: "airQualityMap.mode.label" });
    const pollutant = screen.getByRole("combobox", {
      name: "airQualityMap.pollutant.label",
    });

    expect(mode).toHaveValue("monitors");
    expect(
      within(mode).getByRole("option", { name: "airQualityMap.mode.eeaRaster" }),
    ).toBeDisabled();
    expect(pollutant).toHaveValue("pm25");
    await userEvent.selectOptions(pollutant, "o3");
    expect(useAirQualityStore.getState().mode).toEqual({ kind: "monitors", pollutant: "o3" });
  });

  it.each([
    [{ error: "quota", hasData: false }, "airQualityMap.status.quota"],
    [{ error: "unavailable", hasData: false }, "airQualityMap.status.unavailable"],
    [{ error: "unavailable", hasData: true }, "airQualityMap.status.refreshFailedRetained"],
    [{ error: null, hasData: true, warnings: ["stale_evidence"] }, "airQualityMap.status.stale"],
    [
      { error: null, hasData: true, warnings: ["partial_providers"] },
      "airQualityMap.status.partial",
    ],
    [
      { error: null, hasData: true, warnings: ["quota_truncated"], truncated: true },
      "airQualityMap.status.truncated",
    ],
  ] as const)("renders canonical status %s", (state, expected) => {
    useAirQualityStore.setState(state as never);
    render(<AirQualityLegend />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });

  it("distinguishes loading, an empty successful viewport, and a station count", () => {
    useAirQualityStore.setState({ loading: true });
    const view = render(<AirQualityLegend />);
    expect(screen.getByRole("progressbar")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("airQualityMap.status.loading");

    act(() => useAirQualityStore.setState({ loading: false, hasData: true, stationCount: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("airQualityMap.status.empty");

    act(() => useAirQualityStore.setState({ stationCount: 12 }));
    expect(screen.getByRole("status")).toHaveTextContent("airQualityMap.status.stationCount");
    view.unmount();
  });
});
