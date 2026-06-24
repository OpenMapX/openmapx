import type {
  IntegrationOverlayPopup,
  IntegrationOverlaySource,
} from "@openmapx/integration-framework";
import { describe, expect, it } from "vitest";
import {
  buildOverlaySourceUrl,
  buildPopupHtml,
  namespacedLayerId,
  namespacedSourceId,
} from "./overlaySpec";

const bounds = { west: 4, south: 51, east: 6, north: 53 };

describe("buildOverlaySourceUrl", () => {
  it("appends a comma-joined bbox param by default (west,south,east,north)", () => {
    const source: IntegrationOverlaySource = { kind: "geojson-bbox", route: "/observations" };
    const url = buildOverlaySourceUrl("http://api", "overlay-road-conditions", source, bounds);
    expect(url).toBe(
      "http://api/api/integrations/overlay-road-conditions/observations?bbox=4%2C51%2C6%2C53",
    );
  });

  it("uses separate west/south/east/north params when bboxParam is wsen", () => {
    const source: IntegrationOverlaySource = {
      kind: "geojson-bbox",
      route: "/stations",
      bboxParam: "wsen",
    };
    const url = buildOverlaySourceUrl("http://api", "overlay-air", source, bounds);
    const qs = new URL(url).searchParams;
    expect(qs.get("west")).toBe("4");
    expect(qs.get("south")).toBe("51");
    expect(qs.get("east")).toBe("6");
    expect(qs.get("north")).toBe("53");
  });

  it("merges static extraParams and dynamic params", () => {
    const source: IntegrationOverlaySource = {
      kind: "geojson-bbox",
      route: "/observations",
      extraParams: { domain: "roads" },
    };
    const url = buildOverlaySourceUrl("http://api", "x", source, bounds, { minSeverity: "high" });
    const qs = new URL(url).searchParams;
    expect(qs.get("domain")).toBe("roads");
    expect(qs.get("minSeverity")).toBe("high");
  });

  it("trims a trailing slash on apiBase and tolerates a route without a leading slash", () => {
    const source: IntegrationOverlaySource = { kind: "geojson-bbox", route: "observations" };
    const url = buildOverlaySourceUrl("http://api/", "x", source, bounds);
    expect(url.startsWith("http://api/api/integrations/x/observations?")).toBe(true);
  });
});

describe("namespaced ids", () => {
  it("namespaces layer and source ids by integration id to avoid collisions", () => {
    expect(namespacedSourceId("overlay-road-conditions")).toBe("omx-ext:overlay-road-conditions");
    expect(namespacedLayerId("overlay-road-conditions", "points")).toBe(
      "omx-ext:overlay-road-conditions:points",
    );
  });
});

describe("buildPopupHtml", () => {
  const popup: IntegrationOverlayPopup = {
    titleField: "headline",
    rows: [
      { field: "type", label: "Type" },
      { field: "severity", labelKey: "severity" },
    ],
  };

  it("renders the title and rows from feature properties", () => {
    const html = buildPopupHtml(popup, {
      headline: "Lane closure on A2",
      type: "accident",
      severity: "high",
    });
    expect(html).toContain("Lane closure on A2");
    expect(html).toContain("accident");
    expect(html).toContain("Type");
  });

  it("escapes HTML in field values to prevent injection", () => {
    const html = buildPopupHtml(popup, {
      headline: "<img src=x onerror=alert(1)>",
      type: "x",
      severity: "x",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes HTML in labels too", () => {
    const html = buildPopupHtml(
      { titleField: "t", rows: [{ field: "f", label: "<b>L</b>" }] },
      { t: "Title", f: "v" },
    );
    expect(html).not.toContain("<b>L</b>");
    expect(html).toContain("&lt;b&gt;L&lt;/b&gt;");
  });

  it("omits rows whose field is absent from properties", () => {
    const html = buildPopupHtml(popup, { headline: "Only title" });
    expect(html).toContain("Only title");
    expect(html).not.toContain("Type");
  });
});

describe("buildPopupHtml (rich card)", () => {
  it("humanizes label-formatted enum values", () => {
    const html = buildPopupHtml(
      { titleField: "h", rows: [{ field: "type", label: "Type", format: "label" }] },
      { h: "T", type: "road_closure" },
    );
    expect(html).toContain("Road closure");
    expect(html).not.toContain("road_closure");
  });

  it("renders a colored, humanized severity badge from severityField", () => {
    const html = buildPopupHtml(
      { titleField: "h", severityField: "severity", rows: [] },
      { h: "T", severity: "high" },
    );
    expect(html).toContain("omx-overlay-popup__badge");
    expect(html).toContain("High");
    expect(html).toContain("#cc0033"); // high severity color, inlined
  });

  it("renders chip-variant rows as chips with humanized values", () => {
    const html = buildPopupHtml(
      {
        titleField: "h",
        rows: [{ field: "roadState", label: "Status", format: "label", variant: "chip" }],
      },
      { h: "T", roadState: "closed" },
    );
    expect(html).toContain("omx-overlay-popup__chip");
    expect(html).toContain("Closed");
  });

  it("renders block-variant rows preserving the text and label", () => {
    const html = buildPopupHtml(
      { titleField: "h", rows: [{ field: "description", label: "Details", variant: "block" }] },
      { h: "T", description: "line1\nline2" },
    );
    expect(html).toContain("omx-overlay-popup__block");
    expect(html).toContain("Details");
    expect(html).toContain("line1");
  });

  it("omits object/array values instead of rendering [object Object]", () => {
    const html = buildPopupHtml(
      { titleField: "h", rows: [{ field: "roads", label: "Roads" }] },
      { h: "T", roads: [{ ref: "A1" }] },
    );
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("Roads");
  });

  it("renders an attribution footer from an attribution object's provider", () => {
    const html = buildPopupHtml(
      { titleField: "h", attributionField: "attribution", rows: [] },
      { h: "T", attribution: { provider: "Quelle: Autobahn GmbH", license: "dl-de/by-2-0" } },
    );
    expect(html).toContain("omx-overlay-popup__footer");
    expect(html).toContain("Quelle: Autobahn GmbH");
  });

  it("escapes humanized values and badges", () => {
    const html = buildPopupHtml(
      { titleField: "h", severityField: "s", rows: [{ field: "type", format: "label" }] },
      { h: "T", s: "<x>", type: "<b>x</b>" },
    );
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<x>");
  });
});
