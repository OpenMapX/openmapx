import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpeedLimitBadge } from "./SpeedLimitBadge";

describe("SpeedLimitBadge", () => {
  it("renders nothing when speed limit is null", () => {
    expect(renderToStaticMarkup(<SpeedLimitBadge speedLimit={null} units="metric" />)).toBe("");
  });
  it("renders the limit", () => {
    render(<SpeedLimitBadge speedLimit={50} units="metric" />);
    expect(screen.getByText("50")).toBeInTheDocument();
  });
});
