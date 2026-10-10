import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockNextIntl } from "@/test/intl";
import { TransitDataStatus, TransitQueryNotice } from "./TransitDataStatus";

vi.mock("next-intl", () => mockNextIntl());
const now = Date.parse("2026-10-07T08:00:00Z");
describe("readable transit evidence", () => {
  it("shows only the traveler-facing scheduled-time hint", () => {
    render(<TransitDataStatus now={now} realtime={false} source="ms" />);
    expect(screen.getByText("transit.dataStatus.scheduled")).toBeInTheDocument();
    expect(screen.queryByText(/dataStatus.local|dataStatus.sourceUnknown/)).not.toBeInTheDocument();
  });
  it.each([undefined, new Date(now - 30_000).toISOString()])(
    "adds no diagnostic row for a prediction with upstream timestamp %s",
    (dataAsOf) => {
      const { container } = render(
        <TransitDataStatus
          now={now}
          realtime
          source="mo"
          freshness={{
            fetchedAt: new Date(now).toISOString(),
            dataAsOf,
            hasRealtimeData: true,
            isStale: false,
          }}
        />,
      );
      expect(container.childElementCount).toBe(0);
    },
  );
  it("does not invent a live or scheduled label when service evidence is absent", () => {
    const { container } = render(<TransitDataStatus now={now} source="ms" />);
    expect(container.childElementCount).toBe(0);
  });
  it("warns about outdated predictions without raw source details", () => {
    render(
      <TransitDataStatus
        now={now}
        realtime
        freshness={{
          fetchedAt: new Date(now).toISOString(),
          dataAsOf: new Date(now - 120000).toISOString(),
          hasRealtimeData: true,
          isStale: false,
        }}
        source="mo"
      />,
    );
    expect(screen.getByText("transit.dataStatus.stale")).toBeInTheDocument();
    expect(
      screen.queryByText(/dataStatus.age|dataStatus.hosted|dataStatus.realtime/),
    ).not.toBeInTheDocument();
  });
  it("leaves refresh failure explanations to the board-level notice", () => {
    const { container } = render(<TransitDataStatus now={now} realtime queryFailed source="ms" />);
    expect(container.childElementCount).toBe(0);
  });
  it("exposes a failed refresh with keyboard-accessible retry separately from rows", () => {
    const retry = vi.fn();
    render(<TransitQueryNotice failed partial onRetry={retry} />);
    expect(screen.getByRole("status")).toHaveTextContent("dataStatus.refreshFailed");
    expect(screen.getByRole("status")).toHaveTextContent("dataStatus.partial");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
