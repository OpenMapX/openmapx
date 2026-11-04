import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBadge } from "./PlatformBadge";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

describe("PlatformBadge", () => {
  it("shows a move from the planned platform as a change", () => {
    render(<PlatformBadge code="4" scheduledCode="2" />);
    expect(screen.getByText(/2 → 4/)).toBeTruthy();
  });

  it("shows sections added to the planned platform as the same platform", () => {
    render(<PlatformBadge code="10 A-B" scheduledCode="10" />);
    expect(screen.queryByText(/→/)).toBeNull();
    expect(screen.getByText(/10 A-B/)).toBeTruthy();
  });
});
