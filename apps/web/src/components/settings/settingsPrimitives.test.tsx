// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChoiceRow, SwitchRow } from "./settingsPrimitives";

describe("settings rows", () => {
  it("toggles a switch row from anywhere on the row and explains it in place", () => {
    const onChange = vi.fn();
    render(
      <SwitchRow
        label="Remember map view"
        description="Saved on this device"
        checked={false}
        onChange={onChange}
      />,
    );
    const row = screen.getByRole("switch", { name: "Remember map view" });
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("Saved on this device")).toBeInTheDocument();
    fireEvent.click(row);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("shows the current choice and applies a new one from its picker", () => {
    const onChange = vi.fn();
    render(
      <ChoiceRow
        label="Theme"
        value="light"
        choices={[
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Theme/ }));
    expect(screen.getByRole("radio", { name: "Light" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});
