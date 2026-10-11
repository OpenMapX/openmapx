import { type GantryModel, mergeExitPanel, parseLaneTags } from "@openmapx/core";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GantryStrip } from "./GantryStrip";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

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
  it("keeps one shared physical board when only a subset of its lanes is preferred", () => {
    const model = mergeExitPanel(parseLaneTags({ lanes: 2, destinationLanes: "Target|Target" })!, {
      stepIndex: 1,
      kind: "exit",
      side: "right",
      point: [0, 0],
      alongMeters: 100,
      approachBearing: 90,
      divergenceDeg: 20,
      laneCount: 2,
      activeLanes: [1],
      laneGuidance: {
        lanes: [
          { indications: [], valid: true, preferred: false },
          { indications: [], valid: true, preferred: true },
        ],
        usableLanes: [0, 1],
        preferredLanes: [1],
        state: "known",
      },
      sign: { exitToward: ["Target"] },
    });
    const { container } = render(<GantryStrip model={model} />);
    expect(container.querySelectorAll("[data-panel]")).toHaveLength(1);
    expect(container.querySelector('[data-layout="lane-grid"]')).toBeTruthy();
    expect(container.querySelector("[data-panel]")?.getAttribute("data-lane-span")).toBe("0-1");
    expect(model.laneGuidance?.preferredLanes).toEqual([1]);
  });
  it("emphasizes the selected movement instead of every overlapping board", () => {
    const model: GantryModel = {
      ...threePanels,
      activeLanes: [3, 4],
      panels: threePanels.panels.map((p, i) => (i === 1 ? { ...p, lanes: [3, 4] } : p)),
    };
    const view = render(<GantryStrip model={model} />);
    expect(view.container.querySelectorAll('[data-panel][data-active="true"]')).toHaveLength(1);
  });
  it("positions known boards over their incoming lane spans", () => {
    const view = render(<GantryStrip model={threePanels} />);
    const boards = view.container.querySelectorAll<HTMLElement>("[data-panel]");
    expect(boards[0].getAttribute("data-lane-span")).toBe("0-2");
    expect(boards[2].getAttribute("data-lane-span")).toBe("4-4");
    expect(view.container.querySelector('[data-layout="lane-grid"]')).toBeTruthy();
  });
  it("uses a route card rather than a lane layout for branch-only signs", () => {
    const model: GantryModel = {
      ...threePanels,
      selectedRoute: { refs: ["A2"], destinations: ["Target-Distinguishing Suffix"] },
      panels: threePanels.panels.map((p) => ({ ...p, lanes: [] })),
    };
    const view = render(<GantryStrip model={model} />);
    expect(view.container.querySelector('[data-layout="route-card"]')).toBeTruthy();
    expect(view.container.querySelector("[data-selected-route]")?.textContent).toContain(
      "Target-Distinguishing Suffix",
    );
    expect(view.container.querySelector('[data-layout="lane-grid"]')).toBeNull();
  });
  it("renders one panel per destination group with the exit panel active and badged", () => {
    const html = renderToStaticMarkup(<GantryStrip model={threePanels} />);
    expect(html.match(/data-panel/g)).toHaveLength(3);
    expect(html).toContain("Krefeld");
    expect(html).toContain("Heinsberg");
    expect(html).toContain("Neuss-Zentrum");
    expect(html).toContain("A 57");
    expect(html).toContain("20");
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
  });

  it("keeps panels distinct when the exit panel spans a lane that also has its own board", () => {
    // Live A57 exit 20: lane 4 carries its own destination group and the exit panel.
    const model: GantryModel = {
      ...threePanels,
      panels: [
        ...threePanels.panels.slice(0, 2),
        {
          lanes: [4],
          destinations: ["Heinsberg", "Aachen", "Neuss-Zentrum"],
          refs: ["A 46"],
          symbols: [],
          isExit: false,
        },
        threePanels.panels[2],
      ],
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The duplicate-key check lives in the client reconciler, not the static renderer.
      const { container } = render(<GantryStrip model={model} />);
      expect(container.querySelectorAll("[data-panel]")).toHaveLength(4);
      expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
    } finally {
      error.mockRestore();
    }
  });
});

it("keeps same-ref branches distinct without implying outgoing counts are incoming guidance", () => {
  const model: GantryModel = {
    laneCount: 4,
    activeLanes: [],
    source: "osm",
    panels: [1, 2].map((wayId) => ({
      branchWayId: wayId,
      lanes: [],
      refs: ["A 46"],
      destinations: [wayId === 1 ? "Neuss" : "Heinsberg"],
      symbols: [],
      isExit: wayId === 1,
    })),
    branches: [1, 2].map((wayId) => ({
      wayId,
      bearing: 350 + wayId,
      laneCount: wayId === 1 ? 2 : undefined,
      selected: wayId === 1,
    })),
  };
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { container } = render(<GantryStrip model={model} />);
    expect(container.querySelectorAll("[data-panel]")).toHaveLength(2);
    expect(container.querySelectorAll('[data-active="true"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("2 lanes");
    expect(container.textContent).not.toContain("undefined lanes");
    expect(error.mock.calls.flat().join(" ")).not.toContain("same key");
  } finally {
    error.mockRestore();
  }
});
