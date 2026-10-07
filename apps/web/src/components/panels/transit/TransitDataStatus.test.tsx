import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockNextIntl } from "@/test/intl";
import { TransitDataStatus, TransitQueryNotice } from "./TransitDataStatus";

vi.mock("next-intl", () => mockNextIntl());
const now = Date.parse("2026-10-07T08:00:00Z");
describe("readable transit evidence", () => {
  it("exposes scheduled-only and local source without claiming live coverage", () => {
    render(<TransitDataStatus now={now} realtime={false} source="ms" />);
    expect(screen.getByText(/dataStatus.scheduled/)).toHaveTextContent("dataStatus.local");
    expect(screen.queryByText(/dataStatus.fresh/)).not.toBeInTheDocument();
  });
  it("labels stale predictions and age in text", () => {
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
    expect(screen.getByText(/dataStatus.realtime/)).toHaveTextContent("dataStatus.stale");
    expect(screen.getByText(/dataStatus.realtime/)).toHaveTextContent("dataStatus.age");
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
