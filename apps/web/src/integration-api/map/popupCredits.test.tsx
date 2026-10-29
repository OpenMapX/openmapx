// @vitest-environment jsdom
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { buildPopupCreditsHtml } from "./popupCredits";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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
  },
};
const tfl: Attribution = {
  sourceId: "tfl",
  name: "Transport for London",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "OGL-UK-3.0" } },
    ],
  },
};
/** A road-works receipt as OpenConditions serves it, credited as changed data. */
const mobidata: Attribution = {
  sourceId: "de-bw-svzbw-events",
  name: "MobiData BW roadworks (Baden-Württemberg)",
  url: "https://api.mobidata-bw.de",
  attributionText: "MobiData BW / Ministerium für Verkehr Baden-Württemberg (SVZ-BW)",
  modified: true,
  licensing: {
    version: 1,
    bindings: [
      {
        scope: "data",
        subject: "MobiData BW roadworks (Baden-Württemberg)",
        license: {
          kind: "spdx",
          expression: "DL-DE-BY-2.0",
          url: "https://www.govdata.de/dl-de/by-2-0",
        },
      },
    ],
  },
};

const labels = { modified: "data modified" };

/** Visible credit text and links; the complete credits behind each surface's details action are compared apart. */
function read(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  for (const hidden of root.querySelectorAll('[aria-hidden="true"], details, button'))
    hidden.remove();
  return {
    text: (root.textContent ?? "").replace(/\s+/g, " ").trim(),
    links: [...root.querySelectorAll("a")].map((a) => [a.getAttribute("href"), a.textContent]),
  };
}

describe("buildPopupCreditsHtml", () => {
  it("links each source and its licence as a panel's credit strip does", () => {
    for (const receipts of [[delfi], [tfl], [mobidata], [delfi, tfl, mobidata]]) {
      const popup = read(buildPopupCreditsHtml(receipts, { labels }));
      const strip = read(
        renderToStaticMarkup(<AttributionStrip attributions={receipts} variant="plain" />),
      );
      expect(popup.links).toEqual(strip.links);
      expect(popup.text).toBe(strip.text);
    }
  });

  it("links a source to its site, else to its entry on the licenses page", () => {
    expect(read(buildPopupCreditsHtml([delfi])).links).toEqual([
      ["https://www.delfi.de/", "DELFI · CC-BY-4.0"],
    ]);
    expect(read(buildPopupCreditsHtml([tfl])).links).toEqual([
      ["/licenses#source-tfl", "Transport for London · OGL-UK-3.0"],
    ]);
  });

  it("keeps the complete credit, licence link and change notice one action away", () => {
    const root = document.createElement("div");
    root.innerHTML = buildPopupCreditsHtml([mobidata], { labels, detailsLabel: "Credits" });
    const details = root.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Credits");
    const full = details?.querySelector("ul")?.textContent ?? "";
    expect(full).toContain("MobiData BW / Ministerium für Verkehr Baden-Württemberg (SVZ-BW)");
    expect(full).toContain("data modified");
    expect(
      [...(details?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href")),
    ).toContain("https://www.govdata.de/dl-de/by-2-0");
  });

  it("shows a notice a licence requires beside the content, with its links", () => {
    const required: Attribution = {
      sourceId: "custom",
      name: "City feed",
      url: "https://city.example/",
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Data",
            license: {
              kind: "custom",
              id: "city-terms",
              namespace: "city.example",
              name: "City terms",
              url: "https://city.example/terms",
            },
          },
        ],
      },
    };
    const { text, links } = read(buildPopupCreditsHtml([required], { labels }));
    expect(text).toContain("City feed");
    expect(links.map(([href]) => href)).toContain("https://city.example/");
  });

  it("names a source credited twice once, and nothing without credits", () => {
    expect(read(buildPopupCreditsHtml([delfi, { ...delfi }])).links).toHaveLength(1);
    expect(buildPopupCreditsHtml([])).toBe("");
  });

  it("escapes source-supplied names", () => {
    const html = buildPopupCreditsHtml([{ sourceId: "x", name: '<img src=x onerror="1">' }]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
