import { en } from "@openmapx/i18n";
import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { MapGeoJSONFeature } from "maplibre-gl";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { SharedMapView } from "./SharedMapView";

const fake = createFakeMap();
const env = { styleProvider: "openmapx" };
vi.mock("@/integration-api/runtime/EnvProvider", () => ({ useEnv: () => env }));
vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light" }),
}));
vi.mock("@/lib/map", () => ({
  baseMapVectorCredits: () => [OPENSTREETMAP_ATTRIBUTION],
  loadOpenMapXStyle: async () => ({}),
  loadMaptilerStyle: async () => ({}),
}));
vi.mock("@/lib/maplibreRuntime", () => ({
  loadMapLibreRuntime: async () => ({
    Map: function SharedMapConstructor() {
      return Object.assign(fake.map, { remove: vi.fn() });
    },
  }),
}));
afterEach(() => vi.useRealTimers());

it("keeps captured visible route notices in the compact footer and detail-only notices one action away", async () => {
  vi.useFakeTimers();
  const receipt = (id: string, placement: "visible" | "details") => ({
    sourceId: id,
    name: `${id} publisher`,
    url: `https://${id}.example/`,
    attributionText: `${id} supplied notice`,
    licensing: {
      version: 1 as const,
      bindings: [
        {
          scope: "data" as const,
          subject: "Route geometry",
          license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
          attribution: {
            placement,
            surfaces: ["map" as const],
            basis: "licence" as const,
            reviewedAt: "2026-10-15",
            evidenceUrls: ["https://policy.example/"],
            reason: "Captured placement policy",
          },
        },
      ],
    },
  });
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SharedMapView
        points={[]}
        route={{
          geometry: [
            [0, 0],
            [1, 1],
          ],
          fieldContributors: {
            geometry: [
              receipt("permanent", "visible"),
              receipt("detail", "details"),
              OPENSTREETMAP_ATTRIBUTION,
            ],
          },
        }}
      />
    </NextIntlClientProvider>,
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  act(() => fake.emit("load"));
  const data = fake.state.sources.get("shared-route-source")?.data as GeoJSON.FeatureCollection;
  fake.setRenderedFeatures("shared-route-line", data.features as MapGeoJSONFeature[]);
  act(() => {
    fake.emit("render");
    vi.advanceTimersByTime(250);
  });
  const footer = within(screen.getByTestId("map-credits"));
  expect(footer.getByText(/permanent supplied notice/)).toBeInTheDocument();
  expect(footer.queryByText("detail supplied notice")).not.toBeInTheDocument();
  expect(footer.getAllByRole("link", { name: "OpenStreetMap contributors" })).toHaveLength(1);
  fireEvent.click(footer.getByRole("button", { name: "Map credits" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText(/detail supplied notice/)).toBeInTheDocument();
  expect(dialog.getByText(/permanent supplied notice/)).toBeInTheDocument();
  expect(dialog.getAllByRole("link", { name: "CC-BY-4.0" })).toHaveLength(2);
  view.unmount();
});
