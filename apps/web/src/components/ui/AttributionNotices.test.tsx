import type { VisibleAttribution } from "@openmapx/core/attribution";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AttributionNotices } from "./AttributionNotices";

it("does not accumulate duplicate notices when an earlier credit is added and removed", () => {
  const maptiler: VisibleAttribution = {
    html: '<a href="https://www.maptiler.com/copyright/">MapTiler</a>',
    logos: [],
  };
  const osm: VisibleAttribution = { html: "© OpenStreetMap contributors", logos: [] };
  const terrain: VisibleAttribution = { html: "© Terrain supplier", logos: [] };
  const { rerender, container } = render(
    <AttributionNotices notices={[osm, maptiler, maptiler]} />,
  );
  expect(screen.getAllByRole("link", { name: "MapTiler" })).toHaveLength(2);
  for (let i = 0; i < 4; i++) {
    rerender(<AttributionNotices notices={[osm, terrain, maptiler, maptiler]} />);
    expect(screen.getAllByRole("link", { name: "MapTiler" })).toHaveLength(2);
    expect(container.textContent).toContain("© Terrain supplier");
    rerender(<AttributionNotices notices={[osm, maptiler, maptiler]} />);
    expect(screen.getAllByRole("link", { name: "MapTiler" })).toHaveLength(2);
    expect(container.textContent).not.toContain("© Terrain supplier");
  }
  rerender(<AttributionNotices notices={[maptiler]} />);
  expect(screen.getAllByRole("link", { name: "MapTiler" })).toHaveLength(1);
  rerender(<AttributionNotices notices={[]} />);
  expect(container.textContent).toBe("");
  expect(container.querySelector("a")).toBeNull();
});
