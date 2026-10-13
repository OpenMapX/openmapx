import { afterEach, describe, expect, it } from "vitest";
import { markerMapContributors } from "./markerMapContribution";

const receipt = { sourceId: "pin", name: "Pin supplier" };
afterEach(() => {
  document.body.replaceChildren();
});

function scene() {
  const container = document.createElement("div");
  const marker = document.createElement("div");
  container.append(marker);
  document.body.append(container);
  container.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  let rect = new DOMRect(390, 290, 20, 32);
  marker.getBoundingClientRect = () => rect;
  return {
    container,
    marker,
    move: (next: DOMRect) => {
      rect = next;
    },
  };
}

describe("known painted DOM map markers", () => {
  it("credits a partially visible marker and removes it after panning outside the actual map", () => {
    const s = scene();
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([receipt]);
    s.move(new DOMRect(401, 100, 20, 32));
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([]);
    s.move(new DOMRect(-19, 100, 20, 32));
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([receipt]);
  });
  it("rejects detached, hidden and fully transparent marker ancestors", () => {
    const s = scene();
    s.marker.style.opacity = "0";
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([]);
    s.marker.style.opacity = "1";
    s.container.style.visibility = "hidden";
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([]);
    s.container.style.visibility = "visible";
    s.marker.remove();
    expect(markerMapContributors(s.container, s.marker, [receipt])).toEqual([]);
  });
});
