import type { GantryModel } from "@openmapx/core";
import { render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GantryStrip } from "./GantryStrip";

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
