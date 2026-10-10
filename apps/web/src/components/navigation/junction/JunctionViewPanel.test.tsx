import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "junctionLaneSummary")
      return `Use lane ${String(values?.lane)} of ${String(values?.total)}`;
    if (key === "junctionLanesSummary")
      return `Use lanes ${String(values?.lanes)} of ${String(values?.total)}`;
    if (key === "junctionLaneCount") return `${String(values?.total)} lanes`;
    if (key === "junctionViewLabel") return "Junction view";
    if (key === "junctionBranchesSummary") return `Branches: ${String(values?.branches)}`;
    if (key === "toward") return `toward ${String(values?.places)}`;
    if (key === "junctionPhotoCaption")
      return `© ${String(values?.author)} · ${String(values?.license)} · ${String(values?.date)}`;
    return key;
  },
  useLocale: () => "en",
}));

import type { GantryModel, JunctionLookupResult, Route } from "@openmapx/core";
import {
  buildJunctionSchematic,
  findJunctionCandidates,
  findJunctionDecisionPoints,
  mergeExitPanel,
  parseLaneTags,
  selectApproachWay,
} from "@openmapx/core";
import holz from "../../../../../../packages/core/src/navigation/__fixtures__/junction/a44-kreuz-holz-a46.json";
import fixture from "../../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json";
import { GantryStrip } from "./GantryStrip";
import { JunctionSchematicView } from "./JunctionSchematic";
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

describe("JunctionSchematicView", () => {
  it("draws the schematic SVG with lane bands, one active, and the ramp", () => {
    const schematic = buildJunctionSchematic(threePanels, a57Point);
    const html = renderToStaticMarkup(<JunctionSchematicView schematic={schematic} />);
    expect(html).toContain('viewBox="0 0 320 140"');
    expect(html.match(/data-lane/g)).toHaveLength(5);
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
    expect(html).toContain("data-ramp");
  });
});

describe("JunctionViewPanel", () => {
  it("is an accessible image with the lane summary and toward places", () => {
    const html = renderToStaticMarkup(<JunctionViewPanel point={a57Point} gantry={threePanels} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Use lane 5 of 5, toward Neuss-Zentrum"');
    expect(html).toContain('data-testid="junction-schematic"');
  });

  it("draws bare lane bands when the engine sent lanes but no sign", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={{ ...a57Point, sign: undefined }} />,
    );
    expect(html).not.toContain("data-panel");
    expect(html.match(/data-lane/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Use lane 5 of 5"');
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

  it("draws Kreuz Holz's four lanes without highlighting an unresolved exit side", () => {
    const point = findJunctionCandidates(holz.route as unknown as Route)[0];
    const result = holz.lookup as JunctionLookupResult;
    const approach = selectApproachWay(result.approach, point)!;
    const parsed = parseLaneTags(approach.tags, point.laneCount);
    expect(parsed).not.toBeNull();
    const model = mergeExitPanel(parsed!, point, result.ramps[0].tags);
    const html = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
    expect(html.match(/data-lane/g)).toHaveLength(4);
    expect(html).toContain("Düsseldorf");
    expect(html).not.toContain('data-active="true"');
    expect(html).not.toContain("data-ramp");
    expect(html).not.toContain("Use lane");
    expect(html).toContain('aria-label="4 lanes, toward Düsseldorf, Neuss"');
  });

  it("announces all confirmed lanes of a multi-lane exit", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={a57Point} gantry={{ ...threePanels, activeLanes: [3, 4] }} />,
    );
    expect(html).toContain('aria-label="Use lanes 4, 5 of 5, toward Neuss-Zentrum"');
  });

  it("does not claim a lane recommendation just because the count is known", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={{ ...a57Point, activeLanes: [] }} />,
    );
    expect(html.match(/data-lane/g)).toHaveLength(5);
    expect(html).not.toContain("Use lane");
    expect(html).not.toContain("data-ramp");
  });

  it("renders nothing when the point has no sign and no engine lanes", () => {
    const bare = { ...a57Point, sign: undefined, laneCount: undefined, activeLanes: [] };
    expect(renderToStaticMarkup(<JunctionViewPanel point={bare} />)).toBe("");
  });
});

describe("JunctionViewPanel photo integration", () => {
  const photoImage = {
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
  } as never;

  it("shows the photo when the store marks it ready, the schematic otherwise", () => {
    const withPhoto = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1" }}
        geometry={a57Route.geometry}
      />,
    );
    expect(withPhoto).toContain('data-testid="junction-photo"');
    const schematic = renderToStaticMarkup(
      <JunctionViewPanel point={a57Point} gantry={threePanels} photo={{ status: "loading" }} />,
    );
    expect(schematic).toContain('data-testid="junction-schematic"');
  });

  it("keeps the caption free of links", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1" }}
        geometry={a57Route.geometry}
      />,
    );
    expect(html).not.toContain("<a ");
  });
});

it("shows both connected Kreuz Holz boards and branch roads while withholding incoming guidance", () => {
  const point = findJunctionCandidates(holz.route as unknown as Route)[0];
  const parsed = parseLaneTags(holz.lookup.approach[0].tags)!;
  const model = mergeExitPanel(parsed, point, holz.lookup.ramps[0].tags, {
    ways: holz.lookup.outgoing,
  });
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
  expect(host.querySelectorAll("[data-panel]")).toHaveLength(2);
  expect(host.textContent).toContain("Heinsberg");
  expect(host.textContent).toContain("Venlo");
  expect(host.textContent).toContain("Mönchengladbach");
  expect(host.querySelectorAll("[data-branch-road]")).toHaveLength(2);
  expect(host.querySelectorAll("[data-branch-lane]")).toHaveLength(4);
  expect(host.querySelectorAll('[data-lane][data-active="true"]')).toHaveLength(0);
  expect(host.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("Heinsberg");
  expect(host.innerHTML).not.toContain("Use lane");
});

it("announces outgoing destinations when per-lane boards remain in use", () => {
  const point = findJunctionCandidates(holz.route as unknown as Route)[0];
  const model = mergeExitPanel(
    parseLaneTags({ lanes: 4, destinationLanes: "X|X|Y|Y" })!,
    point,
    undefined,
    { ways: holz.lookup.outgoing },
  );
  const html = renderToStaticMarkup(<JunctionViewPanel point={point} gantry={model} />);
  expect(html.match(/aria-label="([^"]+)"/)?.[1]).toContain("Heinsberg");
  expect(html.match(/aria-label="([^"]+)"/)?.[1]).toContain("2 lanes");
});
