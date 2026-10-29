import { useSettingsStore } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClockTimeField, usesTwelveHourClock } from "./ClockTimeField";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

describe("usesTwelveHourClock", () => {
  it("follows the time-format setting before the locale", () => {
    expect(usesTwelveHourClock("de", "12h")).toBe(true);
    expect(usesTwelveHourClock("en-US", "24h")).toBe(false);
  });

  it("uses the locale's convention on auto", () => {
    expect(usesTwelveHourClock("en-US", "auto")).toBe(true);
    expect(usesTwelveHourClock("de", "auto")).toBe(false);
  });
});

describe("ClockTimeField", () => {
  afterEach(() => useSettingsStore.setState({ timeFormat: "auto" }));

  function renderField(hours: number, minutes: number) {
    const onChange = vi.fn();
    render(
      <ClockTimeField
        label="Opens"
        hours={hours}
        minutes={minutes}
        disabled={false}
        onChange={onChange}
      />,
    );
    return onChange;
  }

  async function openPicker() {
    await userEvent.click(screen.getByRole("textbox", { name: /ohTimePickerOpen/ }));
    return screen.getByRole("dialog");
  }

  it("sets hours and minutes on the dial and applies them on OK", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    const onChange = renderField(9, 30);
    expect(screen.getByDisplayValue("09:30")).toBeTruthy();

    await openPicker();
    const dial = screen.getByRole("slider", { name: "osmContributions.ohTimePickerHours" });
    dial.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(dial.getAttribute("aria-valuenow")).toBe("10");

    await userEvent.click(screen.getByRole("button", { name: /ohTimePickerMinutes/ }));
    const minuteDial = screen.getByRole("slider", { name: "osmContributions.ohTimePickerMinutes" });
    minuteDial.focus();
    await userEvent.keyboard("{ArrowDown}");

    await userEvent.click(screen.getByRole("button", { name: "osmContributions.ohTimePickerOk" }));
    expect(onChange).toHaveBeenCalledWith(10, 29);
  });

  it("discards the dial on cancel", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    const onChange = renderField(9, 30);

    await openPicker();
    screen.getByRole("slider").focus();
    await userEvent.keyboard("{ArrowUp}");
    await userEvent.click(screen.getByRole("button", { name: "osmContributions.cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("accepts typed hours and minutes", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    const onChange = renderField(9, 30);

    await openPicker();
    await userEvent.click(
      screen.getByRole("button", { name: "osmContributions.ohTimePickerToKeyboard" }),
    );
    const hour = screen.getByRole("textbox", { name: "osmContributions.ohTimePickerHour" });
    const minute = screen.getByRole("textbox", { name: "osmContributions.ohTimePickerMinute" });
    const ok = screen.getByRole("button", { name: "osmContributions.ohTimePickerOk" });

    await userEvent.clear(hour);
    await userEvent.type(hour, "25");
    expect(ok.hasAttribute("disabled")).toBe(true);

    await userEvent.clear(hour);
    await userEvent.type(hour, "7");
    await userEvent.clear(minute);
    await userEvent.type(minute, "45");
    await userEvent.click(ok);
    expect(onChange).toHaveBeenCalledWith(7, 45);
  });

  it("reads 24 at the top of a closing-time dial and gives midnight as 24:00", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    const onChange = vi.fn();
    render(
      <ClockTimeField
        label="Closes"
        hours={23}
        minutes={0}
        disabled={false}
        endOfDay
        onChange={onChange}
      />,
    );

    await openPicker();
    expect(screen.getByRole("dialog").textContent).toContain("24");
    screen.getByRole("slider").focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("24");
    await userEvent.click(screen.getByRole("button", { name: "osmContributions.ohTimePickerOk" }));
    expect(onChange).toHaveBeenCalledWith(24, 0);
  });

  it("switches between AM and PM in 12-hour format", async () => {
    useSettingsStore.setState({ timeFormat: "12h" });
    const onChange = renderField(9, 0);
    expect(screen.getByDisplayValue("9:00 AM")).toBeTruthy();

    await openPicker();
    await userEvent.click(screen.getByRole("button", { name: "PM" }));
    await userEvent.click(screen.getByRole("button", { name: "osmContributions.ohTimePickerOk" }));
    expect(onChange).toHaveBeenCalledWith(21, 0);
  });
});
