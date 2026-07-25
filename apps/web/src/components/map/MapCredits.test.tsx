// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MapCredits } from "./MapCredits";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

const CREDITS = [
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  "© MapTiler",
];

describe("MapCredits", () => {
  it("renders every credit inline for a regular embedded map", () => {
    render(<MapCredits html={CREDITS} />);
    const strip = screen.getByTestId("map-credits");
    expect(strip.textContent).toContain("OpenStreetMap");
    expect(strip.textContent).toContain("MapTiler");
  });

  it("renders nothing when there are no credits", () => {
    const { container } = render(<MapCredits html={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("starts collapsed on a minimap and expands on click without triggering the map's own click", () => {
    const onMapClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the clickable minimap wrapper
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the clickable minimap wrapper
      <div onClick={onMapClick}>
        <MapCredits html={CREDITS} compact />
      </div>,
    );
    expect(screen.queryByTestId("map-credits")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "credits" }));

    expect(screen.getByTestId("map-credits").textContent).toContain("OpenStreetMap");
    expect(onMapClick).not.toHaveBeenCalled();
  });

  it("keeps the toggle reachable while expanded so the credits can be collapsed again", () => {
    render(<MapCredits html={CREDITS} compact />);
    const toggle = () => screen.getByRole("button", { name: "credits" });

    fireEvent.click(toggle());
    expect(screen.queryByTestId("map-credits")).not.toBeNull();
    // Regression: the expanded strip used to replace the toggle, leaving no way
    // to close it again.
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(toggle());
    expect(screen.queryByTestId("map-credits")).toBeNull();
  });

  it("does not navigate the host map when the expanded strip is clicked", () => {
    const onMapClick = vi.fn();
    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: stands in for the clickable minimap wrapper
      // biome-ignore lint/a11y/useKeyWithClickEvents: stands in for the clickable minimap wrapper
      <div onClick={onMapClick}>
        <MapCredits html={CREDITS} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("map-credits"));
    expect(onMapClick).not.toHaveBeenCalled();
  });
});
