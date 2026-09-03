import type { Route } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { WalkingHandoffCard } from "./WalkingHandoffCard";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const mockRoute: Route = {
  distance: 240,
  duration: 180,
  geometry: [],
  legs: [],
  steps: [],
  mode: "walking",
};

describe("WalkingHandoffCard", () => {
  it("renders walking duration and distance when route is provided", () => {
    render(<WalkingHandoffCard route={mockRoute} isLoading={false} onStartWalking={vi.fn()} />);
    expect(screen.getByRole("button", { name: /navigation.startWalking/ })).toBeInTheDocument();
  });

  it("calls onStartWalking when Start button is clicked", async () => {
    const onStartWalking = vi.fn();
    render(
      <WalkingHandoffCard route={mockRoute} isLoading={false} onStartWalking={onStartWalking} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /navigation.startWalking/ }));
    expect(onStartWalking).toHaveBeenCalledTimes(1);
  });

  it("renders skeleton loader when isLoading is true", () => {
    render(<WalkingHandoffCard route={mockRoute} isLoading={true} onStartWalking={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /navigation.startWalking/ })).toBeNull();
  });

  it("returns null when route is null and not loading", () => {
    const { container } = render(
      <WalkingHandoffCard route={null} isLoading={false} onStartWalking={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
