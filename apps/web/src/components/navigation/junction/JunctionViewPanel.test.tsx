import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import type { GantryModel, JunctionLookupResult, Route, StreetLevelImage } from "@openmapx/core";
import {
  findJunctionCandidates,
  findJunctionDecisionPoints,
  mergeExitPanel,
  parseLaneTags,
  selectApproachWay,
} from "@openmapx/core";
import type { JunctionPhotoState } from "@/lib/navigation/junctionStore";
import holz from "../../../../../../packages/core/src/navigation/__fixtures__/junction/a44-kreuz-holz-a46.json";
import fixture from "../../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json";
import { GantryStrip } from "./GantryStrip";
import { JunctionViewPanel } from "./JunctionViewPanel";

const a57Route = (fixture as { route: unknown }).route as Route;
const a57Point = findJunctionDecisionPoints(a57Route)[0];

const threePanels: GantryModel = {
  laneCount: 5,
  panels: [
    {
      lanes: [0, 1, 2],
      destinations: ["Krefeld", "Düsseldorf Nord", "Büttgen"],
      refs: ["A 57"],
      symbols: [],
      isExit: false,
    },
    {
      lanes: [3],
      destinations: ["Heinsberg", "Aachen", "Neuss-Holzheim"],
      refs: ["A 46"],
      symbols: [],
      isExit: false,
    },
    {
      lanes: [4],
      destinations: ["Neuss-Zentrum"],
      refs: [],
      symbols: [],
      isExit: true,
      exitNumber: "20",
    },
  ],
  activeLanes: [4],
  source: "osm",
};

const prepared: import("@/lib/navigation/prepareJunctionPhoto").PreparedJunctionPhoto = {
  key: "test",
  width: 640,
  height: 480,
  aspectRatio: 4 / 3,
  path: { points: [], visible: false, laneShiftMeters: 0, headRotateDeg: 0 },
  registration: {
    version: "observed-boundaries-v3",
    scene: "relevant",
    alignment: null,
    evidence: { roadFraction: 1, markingFraction: 1, observedBoundaries: 0 },
  },
  preparationMs: 1,
};

describe("GantryStrip", () => {
  it("renders one panel per destination group with the exit panel active and badged", () => {
    const html = renderToStaticMarkup(<GantryStrip model={threePanels} />);
    expect(html.match(/data-panel/g)).toHaveLength(3);
    expect(html).toContain("Krefeld");
    expect(html).toContain("Heinsberg");
    expect(html).toContain("Neuss-Zentrum");
    expect(html).toContain("A 57");
    expect(html).toContain("20");
    expect(html).toContain('data-active="true"');
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
  });
});

describe("JunctionViewPanel", () => {
  it("announces the selected road before lane guidance without an alternative-branch inventory", () => {
    const point = { ...a57Point, sign: { exitBranches: ["A1"], exitToward: ["Target"] } };
    const model: GantryModel = {
      ...threePanels,
      selectedRoute: { refs: ["A1"], destinations: ["Target"] },
      branches: [{ wayId: 999, bearing: 90, selected: false, destinations: ["Other"] }],
    };
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
    const label = host.querySelector('[role="img"]')?.getAttribute("aria-label");
    expect(label).toMatch(/^A1, Target/);
    expect(label).not.toContain("Other");
  });
  it("is an accessible image with the lane summary and toward places", () => {
    const html = renderToStaticMarkup(<JunctionViewPanel point={a57Point} gantry={threePanels} />);
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Neuss-Zentrum, navigation.exitNumber, navigation.junctionUsableLanes"',
    );
    expect(html).not.toContain('data-testid="junction-schematic"');
    expect(html).toContain("Neuss-Zentrum");
  });

  it("renders nothing when the engine sent lanes but no sign or photo", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={{ ...a57Point, sign: undefined }} />,
    );
    expect(html).toBe("");
  });

  it("builds an engine-only gantry from the sign when no OSM gantry exists", () => {
    const html = renderToStaticMarkup(<JunctionViewPanel point={a57Point} />);
    expect(html).toContain("Neuss-Zentrum");
    expect(html).toContain("20");
  });

  it("keeps the exit sign without a fabricated schematic when the lane count is unknown", () => {
    const point = findJunctionCandidates(holz.route as unknown as Route)[0];
    const html = renderToStaticMarkup(<JunctionViewPanel point={point} />);
    expect(html).toContain("Düsseldorf");
    expect(html).toContain("Neuss");
    expect(html).not.toContain('data-testid="junction-schematic"');
    expect(html).not.toContain("Use lane");
  });

  it("announces Kreuz Holz's four lanes without drawing a schematic or recommending an unresolved lane", () => {
    const point = findJunctionCandidates(holz.route as unknown as Route)[0];
    const result = holz.lookup as JunctionLookupResult;
    const approach = {
      ...selectApproachWay(result.approach, point)!,
      geometry: holz.route.geometry as [number, number][],
    };
    const parsed = parseLaneTags(approach.tags, point.laneCount);
    expect(parsed).not.toBeNull();
    const model = mergeExitPanel(parsed!, point, result.ramps[0].tags, { ways: [], approach });
    const html = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
    expect(html).not.toContain('data-testid="junction-schematic"');
    expect(html).toContain("Düsseldorf");
    expect(html).not.toContain("Prefer lanes");
    expect(html).not.toContain("data-ramp");
    expect(html).not.toContain("Use lane");
    expect(html).toContain(
      'aria-label="A 46, Düsseldorf, Neuss, navigation.junctionLaneGuidanceUnknown"',
    );
  });

  it("announces all confirmed lanes of a multi-lane exit", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={a57Point} gantry={{ ...threePanels, activeLanes: [3, 4] }} />,
    );
    expect(html).toContain(
      'aria-label="Neuss-Zentrum, navigation.exitNumber, navigation.junctionUsableLanes"',
    );
  });

  it("does not claim a lane recommendation just because the count is known", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={{ ...a57Point, activeLanes: [], laneGuidance: undefined }} />,
    );
    expect(html).toContain(
      'aria-label="Neuss-Zentrum, navigation.exitNumber, navigation.junctionLaneGuidanceUnknown"',
    );
    expect(html).not.toContain('data-testid="junction-schematic"');
    expect(html).not.toContain("Use lane");
    expect(html).not.toContain("data-ramp");
  });

  it("renders nothing when the point has no sign and no engine lanes", () => {
    const bare = { ...a57Point, sign: undefined, laneCount: undefined, activeLanes: [] };
    expect(renderToStaticMarkup(<JunctionViewPanel point={bare} />)).toBe("");
  });
});

describe("JunctionViewPanel photo integration", () => {
  const photoImage: StreetLevelImage = {
    id: "photo-1",
    providerId: "panoramax",
    lngLat: [6.679, 51.1786],
    heading: 283,
    capturedAt: "2019-09-10T06:24:40+00:00",
    isPano: false,
    fovDeg: 70,
    assets: {},
    author: "motocultrice",
    license: "CC BY-SA 4.0",
  };

  it.each([false, true])(
    "shows a ref-only route title without inventing a physical board (photo %s)",
    (withPhoto) => {
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(
        <JunctionViewPanel
          point={{ ...a57Point, sign: { exitBranches: ["A 1"] } }}
          photo={
            withPhoto
              ? { status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }
              : undefined
          }
          geometry={a57Route.geometry}
        />,
      );
      expect(host.querySelector("[data-selected-route]")?.textContent).toContain("A 1");
      expect(host.querySelectorAll("[data-panel]")).toHaveLength(0);
      expect(!!host.querySelector('[data-testid="junction-photo"]')).toBe(withPhoto);
      expect(host.querySelector('[data-testid="junction-schematic"]')).toBeNull();
    },
  );

  it.each([false, true])(
    "shows a resolved road-name title without physical boards (photo %s)",
    (withPhoto) => {
      const point = { ...a57Point, sign: undefined, roadNames: ["Example Road"] };
      const model = mergeExitPanel(
        { laneCount: 3, panels: [], activeLanes: [], source: "osm" },
        point,
      );
      expect(model.panels).toHaveLength(0);
      const host = document.createElement("div");
      host.innerHTML = renderToStaticMarkup(
        <JunctionViewPanel
          point={point}
          gantry={model}
          photo={
            withPhoto
              ? { status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }
              : undefined
          }
          geometry={a57Route.geometry}
        />,
      );
      expect(host.querySelector("[data-selected-route]")?.textContent).toContain("Example Road");
      expect(host.querySelectorAll("[data-panel]")).toHaveLength(0);
      expect(!!host.querySelector('[data-testid="junction-photo"]')).toBe(withPhoto);
    },
  );

  it("shows a ready photo below the signs", () => {
    const withPhoto = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }}
        geometry={a57Route.geometry}
      />,
    );
    expect(withPhoto).toContain('data-testid="junction-photo"');
    expect(withPhoto).toContain("Neuss-Zentrum");
    expect(withPhoto).not.toContain('data-testid="junction-schematic"');
  });

  it("shows a ready photo when neither sign nor lane count is known", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={{ ...a57Point, sign: undefined, laneCount: undefined, activeLanes: [] }}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }}
        geometry={a57Route.geometry}
      />,
    );
    expect(html).toContain('data-testid="junction-photo"');
    expect(html).not.toContain("data-panel");
    expect(html).not.toContain('data-testid="junction-schematic"');
    expect(html).toContain(
      'aria-label="navigation.junctionViewLabel, navigation.junctionPhotoCaption"',
    );
  });

  it.each<{ name: string; photo?: JunctionPhotoState }>([
    { name: "not requested" },
    { name: "idle", photo: { status: "idle" } },
    { name: "loading", photo: { status: "loading" } },
    { name: "unavailable", photo: { status: "none" } },
    { name: "bytes pending", photo: { status: "ready", image: photoImage } },
    { name: "image missing", photo: { status: "ready", objectUrl: "blob:photo-1" } },
  ])("shows only signs when the photo is $name", ({ photo }) => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={photo}
        geometry={a57Route.geometry}
      />,
    );
    expect(html).toContain("Neuss-Zentrum");
    expect(html).not.toContain('data-testid="junction-photo"');
    expect(html).not.toContain('data-testid="junction-schematic"');
  });

  it("shows only signs when the route geometry is unavailable", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }}
      />,
    );
    expect(html).toContain("Neuss-Zentrum");
    expect(html).not.toContain('data-testid="junction-photo"');
    expect(html).not.toContain('data-testid="junction-schematic"');
  });

  it("keeps the caption free of links", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1", prepared }}
        geometry={a57Route.geometry}
      />,
    );
    expect(html).not.toContain("<a ");
  });
});

it("shows both connected Kreuz Holz boards without a schematic or incoming lane recommendation", () => {
  const point = findJunctionCandidates(holz.route as unknown as Route)[0];
  const parsed = parseLaneTags(holz.lookup.approach[0].tags)!;
  const model = mergeExitPanel(parsed, point, holz.lookup.ramps[0].tags, {
    ways: holz.lookup.outgoing,
    approach: { ...holz.lookup.approach[0], geometry: holz.route.geometry as [number, number][] },
  });
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
  expect(host.querySelectorAll("[data-panel]")).toHaveLength(2);
  expect(host.textContent).toContain("Heinsberg");
  expect(host.textContent).not.toContain("2 lanes");
  expect(host.querySelector('[data-testid="junction-schematic"]')).toBeNull();
  expect(host.querySelector('[data-testid="junction-photo"]')).toBeNull();
  expect(host.querySelectorAll("[data-branch-road]")).toHaveLength(0);
  expect(host.querySelectorAll("[data-branch-lane]")).toHaveLength(0);
  expect(host.textContent?.match(/2 lanes/g)).toBeNull();
  expect(host.querySelectorAll('[data-lane][data-active="true"]')).toHaveLength(0);
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).not.toContain("Heinsberg");
  expect(host.innerHTML).not.toContain("Use lane");
});

it("keeps the selected route first when alternative lane boards remain in use", () => {
  const point = findJunctionCandidates(holz.route as unknown as Route)[0];
  const model = mergeExitPanel(
    parseLaneTags({ lanes: 4, destinationLanes: "X|X|Y|Y" })!,
    point,
    undefined,
    { ways: holz.lookup.outgoing },
  );
  const html = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
  expect(html.match(/aria-label="([^"]+)"/)?.[1]).toContain("Düsseldorf");
  expect(html.match(/aria-label="([^"]+)"/)?.[1]).not.toContain("Heinsberg");
});
