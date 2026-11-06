import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { DepartureTime } from "./DepartureTime";

vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: (v: string) => v.slice(11, 16) }),
}));
const time = (clock: string) => `2026-11-06T${clock}Z`;
const messages = {
  navigation: { delayMinutes: "+{minutes} min" },
  transit: { scheduledTimeLabel: "Scheduled {time}", expectedTimeLabel: "Expected {time}" },
};
function show(props: Parameters<typeof DepartureTime>[0]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DepartureTime {...props} />
    </NextIntlClientProvider>,
  );
}
describe("shared departure clock", () => {
  it.each([
    ["08:44:00", "08:45:00"],
    ["08:44:50", "08:45:10"],
  ])("shows scheduled, expected and a one-minute delay for %s → %s", (scheduled, expected) => {
    show({ scheduledAt: time(scheduled), expectedAt: time(expected) });
    expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
    expect(screen.getByText("08:45")).not.toHaveStyle({ textDecoration: "line-through" });
    expect(screen.getByText("+1 min")).toBeInTheDocument();
    expect(screen.getByText("Scheduled 08:44. Expected 08:45.")).toBeInTheDocument();
  });
  it("does not show +0 or strike the clock for a change within the displayed minute", () => {
    show({ scheduledAt: time("08:44:10"), expectedAt: time("08:44:50") });
    expect(screen.getAllByText("08:44")).toHaveLength(1);
    expect(screen.getByText("08:44")).not.toHaveStyle({ textDecoration: "line-through" });
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });
  it("shows an earlier prediction without a positive delay", () => {
    show({ scheduledAt: time("08:44:00"), expectedAt: time("08:43:00") });
    expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
    expect(screen.getByText("08:43")).toBeInTheDocument();
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });
  it("ignores an invalid expected time", () => {
    show({ scheduledAt: time("08:44:00"), expectedAt: "invalid" });
    expect(screen.getByText("08:44")).not.toHaveStyle({ textDecoration: "line-through" });
    expect(screen.queryByText(/Expected/)).toBeNull();
  });
  it("shows only a struck scheduled clock for cancellation, leaving its label to the parent", () => {
    show({ scheduledAt: time("08:44:00"), expectedAt: time("08:45:00"), canceled: true });
    expect(screen.getByText("08:44")).toHaveStyle({ textDecoration: "line-through" });
    expect(screen.queryByText("08:45")).toBeNull();
    expect(screen.queryByText(/cancel/i)).toBeNull();
    expect(screen.queryByText(/\+\d/)).toBeNull();
  });
});
