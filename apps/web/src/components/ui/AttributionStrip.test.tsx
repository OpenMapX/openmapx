import type { Attribution } from "@openmapx/mobility-core/attribution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttributionStrip } from "./AttributionStrip";

const delfi: Attribution = {
  sourceId: "delfi-de",
  name: "DELFI",
  url: "https://www.delfi.de/",
  spdxLicense: "CC-BY-4.0",
};
const tfl: Attribution = {
  sourceId: "tfl",
  name: "Transport for London",
  spdxLicense: "OGL-UK-3.0",
};

describe("AttributionStrip", () => {
  it("returns null when there are no attributions", () => {
    const markup = renderToStaticMarkup(<AttributionStrip attributions={[]} />);
    expect(markup).toBe("");
  });

  it("returns null for nullish inputs", () => {
    expect(renderToStaticMarkup(<AttributionStrip attributions={null} />)).toBe("");
    expect(renderToStaticMarkup(<AttributionStrip attributions={undefined} />)).toBe("");
  });

  it("renders one chip per attribution with name and SPDX license", () => {
    const markup = renderToStaticMarkup(<AttributionStrip attributions={[delfi]} />);
    expect(markup).toContain("DELFI");
    expect(markup).toContain("CC-BY-4.0");
    // Linkified by default because attribution.url is set
    expect(markup).toContain('href="https://www.delfi.de/"');
  });

  it("deduplicates attributions by sourceId", () => {
    const markup = renderToStaticMarkup(<AttributionStrip attributions={[delfi, delfi, tfl]} />);
    // Each unique sourceId appears once in the data-source-id attribute.
    expect(markup.match(/data-source-id="delfi-de"/g)?.length).toBe(1);
    expect(markup.match(/data-source-id="tfl"/g)?.length).toBe(1);
  });

  it("falls back to /licenses anchor when attribution has no url", () => {
    const markup = renderToStaticMarkup(<AttributionStrip attributions={[tfl]} />);
    expect(markup).toContain("/licenses#source-tfl");
  });

  it("renders the label when variant is panel-header", () => {
    const markup = renderToStaticMarkup(
      <AttributionStrip attributions={[delfi]} variant="panel-header" label="Data sources:" />,
    );
    expect(markup).toContain("Data sources:");
  });

  it("does not render the label for variants other than panel-header", () => {
    const inline = renderToStaticMarkup(
      <AttributionStrip attributions={[delfi]} variant="inline" label="Data:" />,
    );
    expect(inline).not.toContain("Data:");
  });

  it("renders chips without anchors when navigable=false", () => {
    const markup = renderToStaticMarkup(
      <AttributionStrip attributions={[delfi]} navigable={false} />,
    );
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("DELFI");
  });
});
