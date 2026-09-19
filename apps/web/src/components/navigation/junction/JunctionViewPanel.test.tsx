import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "junctionLaneSummary")
      return `Use lane ${String(values?.lane)} of ${String(values?.total)}`;
    if (key === "junctionViewLabel") return "Junction view";
    if (key === "toward") return `toward ${String(values?.places)}`;
    if (key === "junctionPhotoCaption")
      return `© ${String(values?.author)} · ${String(values?.license)} · ${String(values?.date)}`;
    return key;
  },
  useLocale: () => "en",
}));

import type { GantryModel, Route } from "@openmapx/core";
import { buildJunctionSchematic, findJunctionDecisionPoints } from "@openmapx/core";
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
