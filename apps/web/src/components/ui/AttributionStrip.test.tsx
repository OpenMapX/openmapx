// @vitest-environment jsdom

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttributionStrip } from "./AttributionStrip";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "showMore") return `+${String(values?.count ?? 0)} more`;
    if (key === "showLess") return "Show less";
    return key;
  },
}));

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

  it("collapses chips that render identically (same name + license)", () => {
    // Two distinct registry feeds both crediting the same agency.
    const dbRegio: Attribution = { sourceId: "dyn:de/db-regio", name: "Deutsche Bahn AG" };
    const dbSmart: Attribution = { sourceId: "dyn:de/db-smartrbl", name: "Deutsche Bahn AG" };
    const markup = renderToStaticMarkup(<AttributionStrip attributions={[dbRegio, dbSmart]} />);
    expect(markup.match(/data-source-id=/g)?.length).toBe(1);
    expect(markup).toContain('data-source-id="dyn:de/db-regio"');
    expect(markup).not.toContain('data-source-id="dyn:de/db-smartrbl"');
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

  it("renders HTML attribution text as sanitized links in the tooltip", async () => {
    const routing: Attribution = {
      sourceId: "valhalla-stadia",
      name: "Valhalla (Stadia Maps)",
      url: "https://stadiamaps.com/",
      attributionText:
        'Routing © <a href="https://stadiamaps.com/">Stadia Maps</a>, © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    };
    const { container } = render(<AttributionStrip attributions={[routing]} />);

    fireEvent.mouseOver(container.querySelector("[data-idx]") as HTMLElement);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Routing © Stadia Maps, © OpenStreetMap contributors");
    expect(tooltip.querySelectorAll("a").length).toBe(2);
    expect(tooltip.querySelector('a[href="https://stadiamaps.com/"]')).not.toBeNull();
    expect(
      tooltip.querySelector('a[href="https://www.openstreetmap.org/copyright"]'),
    ).not.toBeNull();
    expect(tooltip.textContent).not.toContain("<a href=");
  });

  it("collapses to maxVisible with a toggle that expands and collapses", () => {
    const items: Attribution[] = [
      { sourceId: "a", name: "Alpha" },
      { sourceId: "b", name: "Bravo" },
      { sourceId: "c", name: "Charlie" },
      { sourceId: "d", name: "Delta" },
    ];
    const { container } = render(<AttributionStrip attributions={items} maxVisible={2} />);
    expect(container.querySelectorAll("[data-source-id]").length).toBe(2);
    const toggle = container.querySelector("button");
    expect(toggle?.textContent).toBe("+2 more");

    fireEvent.click(toggle as HTMLButtonElement);
    expect(container.querySelectorAll("[data-source-id]").length).toBe(4);
    expect(container.querySelector("button")?.textContent).toBe("Show less");

    fireEvent.click(container.querySelector("button") as HTMLButtonElement);
    expect(container.querySelectorAll("[data-source-id]").length).toBe(2);
  });

  it("renders no toggle when item count is within maxVisible", () => {
    const { container } = render(<AttributionStrip attributions={[delfi, tfl]} maxVisible={3} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelectorAll("[data-source-id]").length).toBe(2);
  });
});
