import { useSettingsStore } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enterDateTime } from "@/test/dateTimeField";
import { DateTimeField } from "./DateTimeField";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

function Harness({
  initial = "",
  clearable = false,
  onChange,
}: {
  initial?: string;
  clearable?: boolean;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DateTimeField
      label="Pickup"
      value={value}
      clearable={clearable}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
    />
  );
}

const group = () => screen.getByRole("group", { name: "Pickup" });
const dateInput = () => group().querySelector('input[type="date"]') as HTMLInputElement;

describe("DateTimeField", () => {
  afterEach(() => {
    useSettingsStore.setState({ timeFormat: "auto" });
    vi.useRealTimers();
  });

  it("shows a local date-time value in its two fields", () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    render(<Harness initial="2026-07-04T09:30" onChange={vi.fn()} />);
    expect(dateInput().value).toBe("2026-07-04");
    expect(screen.getByDisplayValue("09:30")).toBeTruthy();
  });

  it("gives a local date-time value from the date and the picker", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await enterDateTime(group(), "2026-07-04T18:05");
    expect(onChange).toHaveBeenLastCalledWith("2026-07-04T18:05");
  });

  it("starts a date picked before any time from the next five minutes", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 6, 4, 9, 31));
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(dateInput(), { target: { value: "2026-07-05" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-07-05T09:35");
  });

  it("places a time picked before any date on today", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date(2026, 6, 4, 9, 31));
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("textbox", { name: "timePicker.choose" }));
    await userEvent.click(screen.getByRole("button", { name: "timePicker.ok" }));
    expect(onChange).toHaveBeenLastCalledWith("2026-07-04T09:35");
  });

  it("clears when clearable", async () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-07-04T09:30" clearable onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "common.clear" }));
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(screen.queryByRole("button", { name: "common.clear" })).toBeNull();
  });

  it("keeps its value when the date is emptied and it is not clearable", () => {
    const onChange = vi.fn();
    render(<Harness initial="2026-07-04T09:30" onChange={onChange} />);
    fireEvent.change(dateInput(), { target: { value: "" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
