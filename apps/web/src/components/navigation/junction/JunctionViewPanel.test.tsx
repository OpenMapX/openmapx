import type { StreetLevelImage } from "@openmapx/core";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { installMeasuredLayout } from "@/test/measuredLayout";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    if (key === "junctionLaneSummary")
      return `Use lane ${String(values?.lane)} of ${String(values?.total)}`;
    if (key === "junctionViewLabel") return "Junction view";
    if (key === "toward") return `toward ${String(values?.places)}`;
    if (key === "junctionPhotoDate") return `Captured ${String(values?.date)}`;
    return key;
  },
  useLocale: () => "en",
}));

import type { GantryModel, Route } from "@openmapx/core";
import { buildJunctionSchematic, findJunctionDecisionPoints } from "@openmapx/core";
import fixture from "../../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json";
import { GantryStrip } from "./GantryStrip";
import { JunctionSchematicView } from "./JunctionSchematic";
import { JunctionViewPanel } from "./JunctionViewPanel";

const a57Route = (fixture as { route: unknown }).route as Route;
const a57Point = findJunctionDecisionPoints(a57Route)[0];

const threePanels: GantryModel = {
  laneCount: 5,
  panels: [
    {
      lanes: [0, 1, 2],
      destinations: ["Krefeld", "Düsseldorf Nord", "Büttgen"],
      refs: ["A 57"],
      symbols: [],
      isExit: false,
    },
    {
      lanes: [3],
      destinations: ["Heinsberg", "Aachen", "Neuss-Holzheim"],
      refs: ["A 46"],
      symbols: [],
      isExit: false,
    },
    {
      lanes: [4],
      destinations: ["Neuss-Zentrum"],
      refs: [],
      symbols: [],
      isExit: true,
      exitNumber: "20",
    },
  ],
  activeLanes: [4],
  source: "osm",
};

describe("GantryStrip", () => {
  it("renders one panel per destination group with the exit panel active and badged", () => {
    const html = renderToStaticMarkup(<GantryStrip model={threePanels} />);
    expect(html.match(/data-panel/g)).toHaveLength(3);
    expect(html).toContain("Krefeld");
    expect(html).toContain("Heinsberg");
    expect(html).toContain("Neuss-Zentrum");
    expect(html).toContain("A 57");
    expect(html).toContain("20");
    expect(html).toContain('data-active="true"');
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
  });
});

describe("JunctionSchematicView", () => {
  it("draws the schematic SVG with lane bands, one active, and the ramp", () => {
    const schematic = buildJunctionSchematic(threePanels, a57Point);
    const html = renderToStaticMarkup(<JunctionSchematicView schematic={schematic} />);
    expect(html).toContain('viewBox="0 0 320 140"');
    expect(html.match(/data-lane/g)).toHaveLength(5);
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
    expect(html).toContain("data-ramp");
  });
});

describe("JunctionViewPanel", () => {
  it("is an accessible image with the lane summary and toward places", () => {
    const html = renderToStaticMarkup(<JunctionViewPanel point={a57Point} gantry={threePanels} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Use lane 5 of 5, toward Neuss-Zentrum"');
    expect(html).toContain('data-testid="junction-schematic"');
  });

  it("draws bare lane bands when the engine sent lanes but no sign", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel point={{ ...a57Point, sign: undefined }} />,
    );
    expect(html).not.toContain("data-panel");
    expect(html.match(/data-lane/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Use lane 5 of 5"');
  });

  it("builds an engine-only gantry from the sign when no OSM gantry exists", () => {
    const html = renderToStaticMarkup(<JunctionViewPanel point={a57Point} />);
    expect(html).toContain("Neuss-Zentrum");
    expect(html).toContain("20");
  });

  it("renders nothing when the point has no sign and no engine lanes", () => {
    const bare = { ...a57Point, sign: undefined, laneCount: undefined, activeLanes: [] };
    expect(renderToStaticMarkup(<JunctionViewPanel point={bare} />)).toBe("");
  });
});

describe("JunctionViewPanel photo integration", () => {
  const photoImage = {
    id: "photo-1",
    providerId: "panoramax",
    lngLat: [6.679, 51.1786],
    heading: 283,
    capturedAt: "2019-09-10T06:24:40+00:00",
    isPano: false,
    fovDeg: 70,
    assets: {},
    author: "motocultrice",
    licensing: licensingFromDeclaration("CC BY-SA 4.0", undefined),
  } as never;

  it("shows the photo when the store marks it ready, the schematic otherwise", () => {
    const withPhoto = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1" }}
        geometry={a57Route.geometry}
      />,
    );
    expect(withPhoto).toContain('data-testid="junction-photo"');
    const schematic = renderToStaticMarkup(
      <JunctionViewPanel point={a57Point} gantry={threePanels} photo={{ status: "loading" }} />,
    );
    expect(schematic).toContain('data-testid="junction-schematic"');
  });

  it("keeps the caption free of links", () => {
    const html = renderToStaticMarkup(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: photoImage, objectUrl: "blob:photo-1" }}
        geometry={a57Route.geometry}
      />,
    );
    expect(html).not.toContain("<a ");
  });
});

const capturedImage: StreetLevelImage = {
  id: "captured-A",
  providerId: "panoramax",
  lngLat: [6.679, 51.1786],
  heading: 283,
  isPano: false,
  fovDeg: 70,
  assets: {},
  capturedAt: "2019-09-10",
  contributors: [
    {
      sourceId: "image-source",
      name: "Photo A",
      url: "https://image.test/a",
      publisher: { name: "Photographer A", url: "https://image.test/author-a" },
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "imagery",
            subject: "Image A",
            license: { kind: "spdx", expression: "CC-BY-SA-4.0" },
            notice: "Complete required image notice A that must wrap in a narrow navigation panel",
            conditions: ["Preserve the embedded notice"],
            attribution: {
              placement: "visible",
              surfaces: ["image"],
              basis: "provider-terms",
              reviewedAt: "2026-10-14",
              evidenceUrls: ["https://image.test/terms"],
              reason: "Image-bound branding",
              logo: "mapillary",
            },
          },
        ],
      },
    },
  ],
};
const replacementImage: StreetLevelImage = {
  ...capturedImage,
  id: "captured-B",
  aspectRatio: 16 / 9,
  contributors: [
    { sourceId: "image-source", name: "Photo B", attributionText: "Required image notice B" },
  ],
};
function photoPanel(image = capturedImage, objectUrl = "blob:captured") {
  return (
    <JunctionViewPanel
      point={a57Point}
      gantry={threePanels}
      photo={{ status: "ready", image, objectUrl }}
      geometry={a57Route.geometry}
    />
  );
}

it("keeps required captured image credits outside the graphic with full one-action details", async () => {
  const { container } = render(photoPanel());
  const graphic = screen.getByRole("img", { name: "Use lane 5 of 5, toward Neuss-Zentrum" });
  expect(graphic.querySelector("button,a")).toBeNull();
  const credits = screen.getByRole("contentinfo");
  expect(graphic.contains(credits)).toBe(false);
  expect(credits.textContent).toContain("Complete required image notice A");
  expect(credits.querySelector('img[alt="Mapillary"]')).not.toBeNull();
  expect(credits.querySelector("[data-source-id]")).toHaveStyle({
    whiteSpace: "normal",
    overflowWrap: "anywhere",
  });
  expect(container.textContent).toContain("Captured Sep 2019");
  const trigger = within(credits).getByRole("button", { name: "attributions" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog");
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(dialog.textContent).toContain("Photographer A");
  expect(dialog.textContent).toContain("CC-BY-SA-4.0");
  expect(dialog.textContent).toContain("Preserve the embedded notice");
  expect(dialog.querySelector('a[href="https://image.test/a"]')).not.toBeNull();
  expect(dialog.querySelector('img[alt="Mapillary"]')).not.toBeNull();
  const shortcuts = vi.fn();
  window.addEventListener("keydown", shortcuts);
  try {
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(shortcuts).not.toHaveBeenCalled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  } finally {
    window.removeEventListener("keydown", shortcuts);
  }
});

it.each(["image", "provider"])(
  "resets measured aspect and attribution dialog when the %s identity changes",
  (identity) => {
    const { container, rerender } = render(photoPanel());
    const img = container.querySelector('[data-testid="junction-photo"] img') as HTMLImageElement;
    Object.defineProperties(img, { naturalWidth: { value: 2000 }, naturalHeight: { value: 1000 } });
    fireEvent.load(img);
    expect(container.querySelector("[data-photo-path]")?.getAttribute("viewBox")).toBe(
      "0 0 100 50",
    );
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    const next =
      identity === "image"
        ? replacementImage
        : { ...replacementImage, id: capturedImage.id, providerId: "another" };
    rerender(photoPanel(next));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.textContent).not.toContain("Complete required image notice A");
    expect(container.textContent).toContain("Required image notice B");
    expect(container.querySelector("[data-photo-path]")?.getAttribute("viewBox")).toBe(
      "0 0 100 56.25",
    );
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    expect(screen.getByRole("dialog").textContent).toContain("Photo B");
    expect(screen.getByRole("dialog").textContent).not.toContain("Photographer A");
  },
);

it.each(["loading", "missing-url", "missing-geometry"])(
  "removes image credits and open details when the displayed photo becomes %s",
  (state) => {
    const { container, rerender } = render(photoPanel());
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    rerender(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={
          state === "loading"
            ? { status: "loading" }
            : {
                status: "ready",
                image: capturedImage,
                objectUrl: state === "missing-url" ? undefined : "blob:captured",
              }
        }
        geometry={state === "missing-geometry" ? undefined : a57Route.geometry}
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(container.querySelector('[data-testid="junction-schematic"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Complete required image notice A");
  },
);

it("treats an empty captured receipt list as authoritative despite legacy image fields", () => {
  const { container } = render(
    photoPanel({
      ...capturedImage,
      contributors: [],
      author: "Invented legacy author",
      licensing: licensingFromDeclaration("CC-BY-SA-4.0"),
    }),
  );
  expect(screen.queryByRole("contentinfo")).toBeNull();
  expect(container.textContent).not.toContain("Invented legacy author");
  expect(container.textContent).toContain("Captured Sep 2019");
});

it("shows the schematic until the full photo fits its measured budget and restores it without a stale dialog", () => {
  let candidateHeight = 500;
  const layout = installMeasuredLayout(
    (el) =>
      new DOMRect(
        0,
        0,
        358,
        el.dataset.testid === "junction-photo-measurement" ? candidateHeight : 250,
      ),
  );
  try {
    const panel = (height: number | null, image = capturedImage) => (
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image, objectUrl: "blob:captured" }}
        geometry={a57Route.geometry}
        availableHeight={height}
      />
    );
    const { container, rerender } = render(panel(null));
    const measurement = container.querySelector('[data-testid="junction-photo-measurement"]');
    expect(measurement).toHaveAttribute("inert");
    expect(measurement).toHaveAttribute("aria-hidden", "true");
    expect(measurement).toHaveStyle({
      visibility: "hidden",
      position: "absolute",
      pointerEvents: "none",
    });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    rerender(panel(500));
    expect(screen.getByRole("contentinfo").textContent).toContain(
      "Complete required image notice A",
    );
    fireEvent.click(screen.getByRole("button", { name: "attributions" }));
    expect(screen.getByRole("dialog")).not.toBeNull();
    rerender(panel(499));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(container.querySelector('[data-testid="junction-schematic"]')).not.toBeNull();
    act(() => {
      layout.resize();
      layout.resize();
    });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    rerender(panel(501));
    expect(screen.getByRole("contentinfo")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      candidateHeight = 600;
      layout.resize();
    });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    act(() => {
      candidateHeight = 350;
      layout.resize();
    });
    expect(screen.getByRole("contentinfo")).not.toBeNull();
    rerender(panel(400, { ...replacementImage, contributors: [] }));
    expect(screen.queryByRole("contentinfo")).toBeNull();
    const visibleGraphic = screen.getByRole("img", {
      name: "Use lane 5 of 5, toward Neuss-Zentrum",
    });
    expect(visibleGraphic.querySelector('[data-testid="junction-photo"]')).not.toBeNull();
    expect(visibleGraphic.querySelector('[data-testid="junction-schematic"]')).toBeNull();
  } finally {
    layout.restore();
  }
});

it("keeps an initially schematic-only card safe after the host budget becomes available", () => {
  const { container } = render(
    <JunctionViewPanel point={a57Point} gantry={threePanels} availableHeight={500} />,
  );
  expect(container.querySelector('[data-testid="junction-schematic"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="junction-photo-measurement"]')).toBeNull();
  expect(screen.queryByRole("contentinfo")).toBeNull();
});

it("keeps each measured and visible route ribbon bound to its own gradient", () => {
  const layout = installMeasuredLayout(() => new DOMRect(0, 0, 358, 400));
  try {
    const { container } = render(
      <JunctionViewPanel
        point={a57Point}
        gantry={threePanels}
        photo={{ status: "ready", image: capturedImage, objectUrl: "blob:captured" }}
        geometry={a57Route.geometry}
        availableHeight={500}
      />,
    );
    const gradients = [...container.querySelectorAll("linearGradient")];
    expect(gradients).toHaveLength(2);
    expect(new Set(gradients.map((gradient) => gradient.id)).size).toBe(2);
    for (const gradient of gradients) {
      expect(gradient.closest("svg")?.querySelector("polygon")).toHaveAttribute(
        "fill",
        `url(#${gradient.id})`,
      );
    }
  } finally {
    layout.restore();
  }
});
