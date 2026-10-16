import type { LabeledPlace } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ labels: [] as LabeledPlace[] }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useLabeledPlaces: () => ({ data: state.labels, isLoading: false }),
  useDeleteLabel: () => ({ mutate: vi.fn() }),
}));

import { SavedLabeledTab } from "./SavedLabeledTab";

it("collects home, work and custom address suppliers and removes unmounted label credits", () => {
  const receipt = { sourceId: "address", name: "Frozen address supplier" };
  state.labels = ["home", "work", "Park"].map((label) => ({
    id: label,
    label,
    icon: null,
    name: label,
    address: "Address",
    lat: 50,
    lng: 8,
    placeId: null,
    fieldContributors: { address: [receipt] },
  }));
  const content = () => (
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SavedLabeledTab />
    </NextIntlClientProvider>
  );
  const view = render(content());
  expect(screen.getAllByText("Frozen address supplier")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Credits" })).toHaveLength(1);
  state.labels = [];
  view.rerender(content());
  expect(screen.queryByText("Frozen address supplier")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Credits" })).not.toBeInTheDocument();
});
