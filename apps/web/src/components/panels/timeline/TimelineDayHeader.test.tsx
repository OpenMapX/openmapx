import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, userEvent } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { calendarDateInTimeZone, offsetCalendarDate, TimelineDayHeader } from "./TimelineDayHeader";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-28T23:30:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TimelineDayHeader", () => {
  it("derives today in the Dawarich timezone and offsets calendar dates without DST math", () => {
    expect(calendarDateInTimeZone(new Date(), "Europe/Berlin")).toBe("2026-03-29");
    expect(calendarDateInTimeZone(new Date(), "America/Los_Angeles")).toBe("2026-03-28");
    expect(offsetCalendarDate("2026-03-29", -1)).toBe("2026-03-28");
    expect(offsetCalendarDate("2026-03-29", 1)).toBe("2026-03-30");
  });

  it("provides previous, next, today and native date controls", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    render(
      <TimelineDayHeader
        date="2026-03-28"
        today="2026-03-29"
        timeZone="Europe/Berlin"
        browserTimeZone="UTC"
        onDateChange={onDateChange}
      />,
    );

    const date = screen.getByLabelText("timeline.datePicker");
    expect(date).toHaveAttribute("type", "date");
    expect(date).toHaveAttribute("max", "2026-03-29");
    expect(screen.getByText("Europe/Berlin")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "timeline.previousDay" }));
    expect(onDateChange).toHaveBeenLastCalledWith("2026-03-27");
    await user.click(screen.getByRole("button", { name: "timeline.nextDay" }));
    expect(onDateChange).toHaveBeenLastCalledWith("2026-03-29");
    await user.click(screen.getByRole("button", { name: "timeline.today" }));
    expect(onDateChange).toHaveBeenLastCalledWith("2026-03-29");
  });

  it("disables next at today and omits a redundant timezone label", () => {
    render(
      <TimelineDayHeader
        date="2026-03-29"
        today="2026-03-29"
        timeZone="Europe/Berlin"
        browserTimeZone="Europe/Berlin"
        onDateChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "timeline.nextDay" })).toBeDisabled();
    expect(screen.queryByText("Europe/Berlin")).toBeNull();
  });

  it("rejects a native picker value beyond today", () => {
    const onDateChange = vi.fn();
    render(
      <TimelineDayHeader
        date="2026-03-29"
        today="2026-03-29"
        timeZone="Europe/Berlin"
        browserTimeZone="UTC"
        onDateChange={onDateChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("timeline.datePicker"), {
      target: { value: "2026-03-30" },
    });
    expect(onDateChange).not.toHaveBeenCalledWith("2026-03-30");
  });

  it("keeps Today available as the direct recovery action from a future date", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onDateChange = vi.fn();
    render(
      <TimelineDayHeader
        date="2026-03-30"
        today="2026-03-29"
        timeZone="Europe/Berlin"
        browserTimeZone="UTC"
        onDateChange={onDateChange}
      />,
    );

    expect(screen.getByRole("button", { name: "timeline.nextDay" })).toBeDisabled();
    const today = screen.getByRole("button", { name: "timeline.today" });
    expect(today).not.toBeDisabled();
    await user.click(today);
    expect(onDateChange).toHaveBeenCalledWith("2026-03-29");
  });
});
