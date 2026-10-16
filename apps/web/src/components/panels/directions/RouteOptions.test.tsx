import { useDirectionsStore } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it } from "vitest";
import { RouteOptions } from "./RouteOptions";

afterEach(() => {
  cleanup();
  useDirectionsStore.setState({
    mode: "driving",
    bikeProfile: "trekking",
    bikeHillPreference: "default",
    bikePreferQuietRoads: false,
    bikePreferSmoothSurfaces: false,
    bikeSpeedKmh: undefined,
  });
});
const draw = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RouteOptions />
    </NextIntlClientProvider>,
  );
it("shows cycling preferences only for cycling and applies selections", () => {
  useDirectionsStore.setState({
    mode: "cycling",
    bikeProfile: "trekking",
    bikeHillPreference: "default",
    bikePreferQuietRoads: false,
    bikePreferSmoothSurfaces: false,
    bikeSpeedKmh: undefined,
  });
  draw();
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Bike type" }));
  fireEvent.click(screen.getByRole("option", { name: "Gravel bike" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Prefer quieter roads" }));
  expect(useDirectionsStore.getState()).toMatchObject({
    bikeProfile: "gravel",
    bikePreferQuietRoads: true,
  });
});
it("keeps driving controls separate", () => {
  useDirectionsStore.setState({ mode: "driving" });
  draw();
  expect(screen.queryByRole("combobox", { name: "Bike type" })).toBeNull();
  expect(screen.getByRole("checkbox", { name: "Highways" })).toBeTruthy();
});

it("applies surface preference and optional pace and restores automatic", () => {
  useDirectionsStore.setState({ mode: "cycling" });
  draw();
  fireEvent.click(screen.getByRole("checkbox", { name: "Prefer smoother surfaces" }));
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Cruising speed" }));
  fireEvent.click(screen.getByRole("option", { name: "20 km/h" }));
  expect(useDirectionsStore.getState()).toMatchObject({
    bikePreferSmoothSurfaces: true,
    bikeSpeedKmh: 20,
  });
  fireEvent.mouseDown(screen.getByRole("combobox", { name: "Cruising speed" }));
  fireEvent.click(screen.getByRole("option", { name: "Automatic for bike type" }));
  expect(useDirectionsStore.getState().bikeSpeedKmh).toBeUndefined();
});

it("displays a shared non-preset cruising speed in imperial units without changing its value", async () => {
  const { useSettingsStore } = await import("@openmapx/core");
  const previous = useSettingsStore.getState().units;
  useSettingsStore.setState({ units: "imperial" });
  useDirectionsStore.setState({ mode: "cycling", bikeSpeedKmh: 19.5 });
  draw();
  expect(screen.getByRole("combobox", { name: "Cruising speed" }).textContent).toContain(
    "12.1 mph",
  );
  expect(useDirectionsStore.getState().bikeSpeedKmh).toBe(19.5);
  useSettingsStore.setState({ units: previous });
});
