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
