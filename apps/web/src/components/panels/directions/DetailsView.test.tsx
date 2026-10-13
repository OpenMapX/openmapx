import type { Route } from "@openmapx/core";
import { fireEvent, render as renderDom, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DetailsView } from "./DetailsView";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useCountryFromCoordinates: () => ({ data: null }),
  useNavigationStore: () => null,
}));
vi.mock("@/components/elevation/ElevationProfile", () => ({ ElevationProfile: () => null }));
vi.mock("@/components/panels/directions/DirectionsDetailHeader", () => ({
  DirectionsDetailHeader: () => null,
}));
vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: ({ attributions }: { attributions: { name: string }[] }) => (
    <span>{attributions.map((receipt) => receipt.name).join(" | ")}</span>
  ),
}));

const route: Route = {
  mode: "driving",
  distance: 1,
  duration: 1,
  geometry: [
    [0, 0],
    [1, 1],
  ],
  legs: [],
  steps: [],
};
const selected = { sourceId: "selected", name: "Selected supplier" };
const unrelated = { sourceId: "unrelated", name: "Other query supplier" };
function render(route: Route) {
  return renderToStaticMarkup(
    <DetailsView
      route={route}
      originLabel="Origin"
      destinationLabel="Destination"
      units="metric"
      onBack={() => {}}
      attributions={[unrelated]}
    />,
  );
}

describe("displayed route details receipts", () => {
  it("uses the selected route's canonical snapshot and respects an empty snapshot", () => {
    expect(render({ ...route, contributors: [selected] })).toContain("Selected supplier");
    expect(render({ ...route, contributors: [selected] })).not.toContain("Other query supplier");
    expect(render({ ...route, contributors: [] })).not.toContain("Other query supplier");
  });
  it("projects only fields displayed in the route details", () => {
    const markup = render({
      ...route,
      contributors: [selected, unrelated],
      fieldContributors: { duration: [selected], distance: [], geometry: [unrelated] },
    });
    expect(markup).toContain("Selected supplier");
    expect(markup).not.toContain("Other query supplier");
  });
});

it("credits independently supplied visible step rows and clears their receipt on collapse", () => {
  const step = {
    instruction: "Turn",
    distance: 1,
    duration: 1,
    coordinates: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
    contributors: [selected],
  };
  const leg = {
    distance: 1,
    duration: 1,
    geometry: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
    steps: [step],
    contributors: [],
  };
  const value = {
    ...route,
    contributors: [],
    fieldContributors: { distance: [], duration: [] },
    legs: [leg, { ...leg, steps: [] }],
  };
  const view = renderDom(
    <DetailsView
      route={value}
      originLabel="Origin"
      destinationLabel="Destination"
      waypointLabels={["Origin", "Via", "Destination"]}
      units="metric"
      onBack={() => {}}
    />,
  );
  expect(screen.getByText("Selected supplier")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Origin → Via"));
  expect(screen.queryByText("Selected supplier")).toBeNull();
  view.unmount();
});

it("excludes maneuver and empty lane receipts when no lane guidance is displayed", () => {
  const hidden = {
    sourceId: "hidden",
    name: "Hidden lane notice",
    attributionText: "Unused maneuver notice",
  };
  const step = {
    instruction: "Continue",
    distance: 1,
    duration: 1,
    coordinates: route.geometry,
    lanes: [],
    maneuver: { type: "turn" },
    contributors: [],
    fieldContributors: { instruction: [selected], lanes: [hidden], maneuver: [hidden] },
  };
  const markup = render({ ...route, contributors: [], fieldContributors: {}, steps: [step] });
  expect(markup).toContain("Selected supplier");
  expect(markup).not.toContain("Hidden lane notice");
});

it("never assigns an unused driving inline elevation supplier to detail metrics", () => {
  expect(
    render({
      ...route,
      contributors: [],
      fieldContributors: { elevation: [unrelated] },
      elevation: [1, 2],
    }),
  ).not.toContain("Other query supplier");
});

it("includes lane and maneuver inputs when the production step displays guidance", () => {
  const lanes = { sourceId: "lanes", name: "Visible lane inputs" };
  const maneuver = { sourceId: "maneuver", name: "Visible recommendation" };
  const markup = render({
    ...route,
    contributors: [],
    fieldContributors: {},
    steps: [
      {
        instruction: "Turn",
        distance: 1,
        duration: 1,
        coordinates: route.geometry,
        lanes: [{ indications: ["right"], valid: true }],
        maneuver: { type: "turn", modifier: "right" },
        contributors: [],
        fieldContributors: { lanes: [lanes], maneuver: [maneuver] },
      },
    ],
  });
  expect(markup).toContain('data-valid="true"');
  expect(markup).toContain("Visible lane inputs");
  expect(markup).toContain("Visible recommendation");
});

it("honors empty acquired children when real concatenation retains a parent legs receipt", async () => {
  const { concatenateRoutes } = await import("@integrations/routing/route-concat");
  const hidden = { sourceId: "parent", name: "Hidden parent receipt" };
  const first: Route = {
    ...route,
    contributors: [],
    fieldContributors: { legs: [hidden], "legs.0.summary": [hidden] },
    legs: [{ distance: 1, duration: 1, geometry: route.geometry, steps: [], contributors: [] }],
  };
  const joined = concatenateRoutes([first, { ...first, fieldContributors: {} }]);
  expect(joined.fieldContributors?.legs).toEqual([hidden]);
  expect(joined.fieldContributors?.["legs.0"]).toEqual([]);
  expect(render(joined)).not.toContain("Hidden parent receipt");
});

it("projects displayed legacy nested rows through the composed indexed field tree", async () => {
  const { concatenateRoutes } = await import("@integrations/routing/route-concat");
  const first: Route = {
    ...route,
    contributors: [],
    fieldContributors: { "legs.0.steps.0.instruction": [selected], "legs.0.summary": [unrelated] },
    legs: [
      {
        distance: 1,
        duration: 1,
        geometry: route.geometry,
        steps: [{ instruction: "Continue", distance: 1, duration: 1, coordinates: route.geometry }],
      },
    ],
  };
  const joined = concatenateRoutes([
    first,
    {
      ...route,
      contributors: [],
      fieldContributors: {},
      legs: [{ distance: 1, duration: 1, geometry: route.geometry, steps: [] }],
    },
  ]);
  const markup = render(joined);
  expect(markup).toContain("Selected supplier");
  expect(markup).not.toContain("Other query supplier");
});
