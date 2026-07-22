// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { collapseCompactAttribution } from "./LocationMinimap";

/**
 * Build the DOM MapLibre 5's compact AttributionControl produces on init:
 * a `<details open>` carrying both `maplibregl-compact` and the
 * `maplibregl-compact-show` class that renders it expanded.
 */
function mapContainerWithExpandedAttribution(): HTMLElement {
  const container = document.createElement("div");
  const details = document.createElement("details");
  details.className =
    "maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show";
  details.setAttribute("open", "");
  container.appendChild(details);
  return container;
}

describe("collapseCompactAttribution", () => {
  it("collapses an expanded compact attribution to the info button", () => {
    const container = mapContainerWithExpandedAttribution();
    collapseCompactAttribution(container);

    const attrib = container.querySelector(".maplibregl-ctrl-attrib");
    expect(attrib?.classList.contains("maplibregl-compact-show")).toBe(false);
    expect(attrib?.hasAttribute("open")).toBe(false);
    // Still compact — the info button remains so the attribution stays reachable.
    expect(attrib?.classList.contains("maplibregl-compact")).toBe(true);
  });

  it("is a no-op when the attribution is already collapsed", () => {
    const container = document.createElement("div");
    const details = document.createElement("details");
    details.className = "maplibregl-ctrl-attrib maplibregl-compact";
    container.appendChild(details);

    expect(() => collapseCompactAttribution(container)).not.toThrow();
    expect(details.hasAttribute("open")).toBe(false);
  });

  it("does nothing when there is no compact attribution control", () => {
    const container = document.createElement("div");
    expect(() => collapseCompactAttribution(container)).not.toThrow();
  });
});
