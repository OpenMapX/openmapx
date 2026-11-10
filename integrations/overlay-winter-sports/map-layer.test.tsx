import { describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({}) }));
vi.mock("maplibre-gl", () => ({ Popup: class {} }));

const { liftPopupHtml, pistePopupHtml } = await import("./map-layer");

const MARKUP = '<img src="https://tracker.example/p.gif"><meta http-equiv="refresh" content="0">';

describe("pistePopupHtml", () => {
  it("shows an unlisted piste type as text, not markup", () => {
    const html = pistePopupHtml({ name: "Run", difficulty: "easy", pisteType: MARKUP });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<meta");
    expect(html).toContain("&lt;img src=&quot;https://tracker.example/p.gif&quot;&gt;");
  });

  it("labels a known piste type", () => {
    const html = pistePopupHtml({ name: "Run", difficulty: "easy", pisteType: "nordic" });
    expect(html).toContain("Cross-Country");
  });

  it("shows markup in the name and difficulty as text", () => {
    const html = pistePopupHtml({ name: MARKUP, difficulty: MARKUP, pisteType: "downhill" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<meta");
  });
});

describe("liftPopupHtml", () => {
  it("shows an unknown aerialway type as text, not markup", () => {
    const html = liftPopupHtml({ name: "Lift", aerialway: MARKUP });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<meta");
  });
});
