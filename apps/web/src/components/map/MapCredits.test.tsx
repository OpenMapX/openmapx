// @vitest-environment jsdom
import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OPENMAPTILES_ATTRIBUTION } from "@/lib/map";
import { MapCredits } from "./MapCredits";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
const CREDITS = [OPENSTREETMAP_ATTRIBUTION, OPENMAPTILES_ATTRIBUTION];
describe("MapCredits", () => {
  it("keeps required OSM and schema credits permanently present even on minimaps", () => {
    render(<MapCredits attributions={CREDITS} />);
    const strip = screen.getByTestId("map-credits");
    expect(strip.textContent).toContain("OpenStreetMap");
    expect(strip.textContent).toContain("OpenMapTiles");
    expect(strip.querySelector('a[href="https://openmaptiles.org/"]')).not.toBeNull();
  });
  it("renders nothing when there are no credits", () => {
    expect(render(<MapCredits attributions={[]} />).container.innerHTML).toBe("");
  });
  it("opens complete details in one action without navigating the host map", async () => {
    const onMapClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: Simulates the map parent click listener, not a product control.
      <div role="presentation" onClick={onMapClick}>
        <MapCredits attributions={CREDITS} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "credits" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("BSD-3-Clause");
    expect(dialog.textContent).toContain("ODbL-1.0");
    expect(onMapClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "close" }));
    expect(screen.getByTestId("map-credits").textContent).toContain("OpenMapTiles");
  });
  it("never makes a required source link navigate the enclosing map", () => {
    const onMapClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: Simulates the map parent click listener, not a product control.
      <div role="presentation" onClick={onMapClick}>
        <MapCredits attributions={CREDITS} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("map-credits"));
    expect(onMapClick).not.toHaveBeenCalled();
  });
});

it("links distinct captured terms in details with a short label and keeps raw URLs out of credit copy", async () => {
  const url = "https://historical.example/original-terms";
  render(
    <MapCredits
      attributions={[
        {
          sourceId: "history",
          name: "Historical source",
          licensing: {
            version: 1,
            bindings: [
              {
                scope: "data",
                subject: "Historical data",
                license: { kind: "spdx", expression: "CC-BY-4.0" },
              },
            ],
            declarations: [
              { text: "CC-BY-4.0", url },
              { text: "Repeated declaration", url },
            ],
          },
        },
      ]}
    />,
  );
  expect(screen.getByTestId("map-credits").textContent).not.toContain(url);
  fireEvent.click(screen.getByRole("button", { name: "credits" }));
  await screen.findByRole("dialog");
  const links = screen.getAllByRole("link", { name: "termsOfUse" });
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("href")).toBe(url);
  expect(screen.queryByText(url)).toBeNull();
});
