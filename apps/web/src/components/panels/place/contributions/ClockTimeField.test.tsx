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

  function sectionText(name: RegExp): string | null {
    return screen.getByRole("spinbutton", { name }).textContent;
  }

  it("shows the time and reports a typed change", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    const onChange = vi.fn();
    render(
      <ClockTimeField label="Opens" hours={9} minutes={30} disabled={false} onChange={onChange} />,
    );

    expect(sectionText(/hours/i)).toBe("09");
    expect(sectionText(/minutes/i)).toBe("30");

    await userEvent.click(screen.getByRole("spinbutton", { name: /hours/i }));
    await userEvent.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith(10, 30);
  });

  it("offers the clock dial", async () => {
    useSettingsStore.setState({ timeFormat: "24h" });
    render(
      <ClockTimeField label="Opens" hours={9} minutes={0} disabled={false} onChange={vi.fn()} />,
    );

    await userEvent.click(screen.getByRole("button", { name: /choose time/i }));
    expect(await screen.findByRole("listbox", { name: /select hours/i })).toBeTruthy();
  });
});
