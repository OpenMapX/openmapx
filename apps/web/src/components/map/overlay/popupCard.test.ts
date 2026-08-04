import { describe, expect, it } from "vitest";
import { buildPopupCard, buildStackedPopupCardItems, type PopupCardSpec } from "./popupCard";

describe("buildPopupCard", () => {
  const spec: PopupCardSpec = {
    titleField: "headline",
    rows: [
      { field: "type", label: "Type" },
      { field: "severity", labelKey: "severity" },
    ],
  };

  it("renders the title and rows from feature properties", () => {
    const html = buildPopupCard(spec, {
      headline: "Lane closure on A2",
      type: "accident",
      severity: "high",
    });
    expect(html).toContain("Lane closure on A2");
    expect(html).toContain("accident");
    expect(html).toContain("Type");
  });

  it("escapes HTML in field values to prevent injection", () => {
    const html = buildPopupCard(spec, {
      headline: "<img src=x onerror=alert(1)>",
      type: "x",
      severity: "x",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes HTML in labels too", () => {
    const html = buildPopupCard(
      { titleField: "t", rows: [{ field: "f", label: "<b>L</b>" }] },
      { t: "Title", f: "v" },
    );
    expect(html).not.toContain("<b>L</b>");
    expect(html).toContain("&lt;b&gt;L&lt;/b&gt;");
  });

  it("omits rows whose field is absent from properties", () => {
    const html = buildPopupCard(spec, { headline: "Only title" });
    expect(html).toContain("Only title");
    expect(html).not.toContain("Type");
  });

  it("humanizes label-formatted enum values", () => {
    const html = buildPopupCard(
      { titleField: "h", rows: [{ field: "type", label: "Type", format: "label" }] },
      { h: "T", type: "road_closure" },
    );
    expect(html).toContain("Road closure");
    expect(html).not.toContain("road_closure");
  });

  it("renders a colored, humanized severity badge from severityField", () => {
    const html = buildPopupCard(
      { titleField: "h", severityField: "severity", rows: [] },
      { h: "T", severity: "high" },
    );
    expect(html).toContain("omx-overlay-popup__badge");
    expect(html).toContain("High");
    expect(html).toContain("#cc0033"); // high severity color, inlined
  });

  it("uses a configured localized label for the severity badge", () => {
    const html = buildPopupCard(
      { titleField: "h", severityField: "severity", severityLabelField: "severityText", rows: [] },
      { h: "T", severity: "medium", severityText: "Mittel" },
    );

    expect(html).toContain("Mittel");
    expect(html).not.toContain(">Medium<");
    expect(html).toContain("#ff9933"); // medium severity color still uses the raw value
  });

  it("omits the severity badge when severity is unknown or empty", () => {
    for (const severity of ["unknown", "Unknown", "", null]) {
      const html = buildPopupCard(
        { titleField: "h", severityField: "severity", rows: [] },
        { h: "T", severity },
      );
      expect(html).not.toContain("omx-overlay-popup__badge");
    }
  });

  it("renders chip-variant rows as chips with humanized values", () => {
    const html = buildPopupCard(
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
    const html = buildPopupCard(
      { titleField: "h", rows: [{ field: "description", label: "Details", variant: "block" }] },
      { h: "T", description: "line1\nline2" },
    );
    expect(html).toContain("omx-overlay-popup__block");
    expect(html).toContain("Details");
    expect(html).toContain("line1");
  });

  it("omits object/array values instead of rendering [object Object]", () => {
    const html = buildPopupCard(
      { titleField: "h", rows: [{ field: "roads", label: "Roads" }] },
      { h: "T", roads: [{ ref: "A1" }] },
    );
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("Roads");
  });

  it("renders an attribution footer from an attribution object's provider", () => {
    const html = buildPopupCard(
      { titleField: "h", attributionField: "attribution", rows: [] },
      { h: "T", attribution: { provider: "Quelle: Autobahn GmbH", license: "dl-de/by-2-0" } },
    );
    expect(html).toContain("omx-overlay-popup__footer");
    expect(html).toContain("Quelle: Autobahn GmbH");
  });

  it("escapes humanized values and badges", () => {
    const html = buildPopupCard(
      { titleField: "h", severityField: "s", rows: [{ field: "type", format: "label" }] },
      { h: "T", s: "<x>", type: "<b>x</b>" },
    );
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<x>");
  });

  it("keeps source details collapsed inside their owning stack item", () => {
    const html = buildStackedPopupCardItems(
      { titleField: "headline", rows: [{ field: "recordId", label: "Record" }] },
      [
        {
          properties: { headline: "Grouped roadworks", recordId: "6 source records" },
          details: {
            label: "Source details (6 records)",
            entries: [
              { headline: "Road works", recordId: "record <1>" },
              { headline: "Road works", recordId: "record <2>" },
            ],
          },
        },
        { properties: { headline: "Separate incident" } },
      ],
      undefined,
      "2 conditions here",
    );

    expect(html).toContain("2 conditions here");
    expect(html.match(/omx-overlay-popup__section/g)).toHaveLength(2);
    expect(html).toContain('<details class="omx-overlay-popup__details">');
    expect(html).toContain("Source details (6 records)");
    expect(html).toContain("record &lt;1&gt;");
    expect(html).not.toContain("<details open");
  });

  it("renders a single item with details without turning it into a stack", () => {
    const html = buildStackedPopupCardItems({ titleField: "headline", rows: [] }, [
      {
        properties: { headline: "Grouped roadworks" },
        details: { label: "Source details", entries: [{ headline: "Road works" }] },
      },
    ]);

    expect(html).toContain("Grouped roadworks");
    expect(html).toContain("Source details");
    expect(html).not.toContain("omx-overlay-popup--stack");
  });
});
