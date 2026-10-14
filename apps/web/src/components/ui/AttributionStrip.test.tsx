import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
// @vitest-environment jsdom

import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
    ],
  } as const,
};
const tfl: Attribution = {
  sourceId: "tfl",
  name: "Transport for London",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "OGL-UK-3.0" } },
    ],
  } as const,
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

  it("preserves distinct required notices and links even when source and label match", () => {
    const credits: Attribution[] = [
      { sourceId: "agency", name: "Agency", attributionText: "Required notice A" },
      { sourceId: "agency", name: "Agency", attributionText: "Required notice B" },
      { sourceId: "other-feed", name: "Agency", url: "https://other.example" },
    ];
    const markup = renderToStaticMarkup(<AttributionStrip attributions={credits} />);
    expect(markup.match(/data-source-id=/g)?.length).toBe(3);
    expect(markup).toContain('href="https://other.example"');
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

  it("renders plain source credits as linked text with an accessible localized label", () => {
    const markup = renderToStaticMarkup(
      <AttributionStrip attributions={[delfi, delfi, tfl]} variant="plain" label="Datenquellen" />,
    );
    expect(markup).toContain('aria-label="Datenquellen"');
    expect(markup.match(/data-source-id="delfi-de"/g)?.length).toBe(1);
    expect(markup).toContain('href="https://www.delfi.de/"');
    expect(markup).toContain('href="/licenses#source-tfl"');
    expect(markup).toContain("CC-BY-4.0");
    expect(markup).not.toContain("Datenquellen<");
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

  it("moves a long license description from the chip into the tooltip", async () => {
    const transitous: Attribution = {
      sourceId: "transitous",
      name: "Transitous",
      licensing: licensingFromDeclaration(
        "Mixed (per upstream GTFS/GBFS feed; mostly open data)",
        undefined,
        "Transitous",
      ),
      attributionText: "Public transport data via Transitous",
    };
    const { container } = render(
      <AttributionStrip attributions={[transitous]} variant="panel-header" label="Data sources" />,
    );
    expect(container.querySelector("[data-source-id]")?.textContent).toContain(
      "Public transport data via Transitous",
    );

    fireEvent.mouseOver(container.querySelector("[data-idx]") as HTMLElement);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("Public transport data via Transitous");
    expect(tooltip.textContent).toContain("Mixed (per upstream GTFS/GBFS feed; mostly open data)");
  });

  it("keeps a short license label on the chip", () => {
    const markup = renderToStaticMarkup(
      <AttributionStrip
        attributions={[
          {
            sourceId: "entur",
            name: "Entur",
            licensing: licensingFromDeclaration("NLOD 2.0", undefined, "Entur"),
          },
        ]}
      />,
    );
    expect(markup).toContain("Entur · NLOD-2.0");
  });

  it("collapses to maxVisible with a toggle that expands and collapses", () => {
    const items: Attribution[] = [
      { sourceId: "a", name: "Alpha", licensing: licensingFromDeclaration("CC0-1.0") },
      { sourceId: "b", name: "Bravo", licensing: licensingFromDeclaration("CC0-1.0") },
      { sourceId: "c", name: "Charlie", licensing: licensingFromDeclaration("CC0-1.0") },
      { sourceId: "d", name: "Delta", licensing: licensingFromDeclaration("CC0-1.0") },
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
    expect(screen.getByRole("button", { name: "attributions" })).not.toBeNull();
    expect(container.querySelectorAll("[data-source-id]").length).toBe(2);
  });
});

it("never puts required notices behind maxVisible or a hover-only tooltip", () => {
  const items = [
    { sourceId: "eligible", name: "Eligible", licensing: licensingFromDeclaration("CC-BY-4.0") },
    { sourceId: "a", name: "A", attributionText: "Exact required notice A" },
    { sourceId: "b", name: "B", attributionText: "Exact required notice B" },
  ];
  const { container } = render(<AttributionStrip attributions={items} maxVisible={1} />);
  expect(container.textContent).toContain("Exact required notice A");
  expect(container.textContent).toContain("Exact required notice B");
  expect(container.querySelectorAll("[data-source-id]")).toHaveLength(3);
});

it("makes every full licence, notice and software subject reachable in one touch action", () => {
  const { container } = render(<AttributionStrip attributions={[delfi]} />);
  fireEvent.click(screen.getByRole("button", { name: "attributions" }));
  expect(screen.getByRole("dialog").textContent).toContain("CC-BY-4.0");
  expect(
    screen.getByRole("dialog").querySelector('a[href="https://www.delfi.de/"]'),
  ).not.toBeNull();
  expect(container.querySelector("[data-source-id]")).not.toBeNull();
});

it("opens details without triggering an enclosing image/map action", () => {
  const parent = vi.fn();
  render(
    // biome-ignore lint/a11y/noStaticElementInteractions: Simulates an enclosing image click listener, not a product control.
    <div role="presentation" onClick={parent}>
      <AttributionStrip
        attributions={[
          { sourceId: "cc", name: "Author", licensing: licensingFromDeclaration("CC-BY-4.0") },
        ]}
        maxVisible={0}
      />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "attributions" }));
  expect(parent).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("keeps gallery navigation shortcuts from reaching the window while attribution details has focus", async () => {
  const shortcuts = vi.fn();
  window.addEventListener("keydown", shortcuts);
  try {
    render(<AttributionStrip attributions={[delfi]} />);
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "ArrowRight" });
    expect(shortcuts).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  } finally {
    window.removeEventListener("keydown", shortcuts);
  }
});

it("retains mandatory branding in the details dialog even if the dialog covers the image or map footer", () => {
  render(
    <AttributionStrip
      attributions={[
        {
          sourceId: "mapillary",
          name: "Mapillary",
          licensing: {
            version: 1,
            bindings: [
              {
                scope: "service",
                subject: "API",
                license: { kind: "unknown" },
                attribution: {
                  placement: "visible",
                  surfaces: ["image"],
                  basis: "provider-terms",
                  reviewedAt: "2026-10-14",
                  evidenceUrls: ["https://www.mapillary.com/terms"],
                  reason: "Linked visible logo",
                  logo: "mapillary",
                  compactText: "Mapillary",
                },
              },
            ],
          },
        },
      ]}
      surface="image"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "attributions" }));
  expect(screen.getByRole("dialog").querySelector('img[alt="Mapillary"]')).not.toBeNull();
  expect(
    screen.getByRole("dialog").querySelector('a[href="https://www.mapillary.com/"]'),
  ).not.toBeNull();
});
