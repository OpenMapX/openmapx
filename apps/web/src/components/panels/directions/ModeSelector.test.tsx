import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ModeButton } from "./ModeSelector";

function Modes({ onChange = vi.fn() }: { onChange?: (mode: string) => void }) {
  const [mode, setMode] = useState("driving");
  const choose = (next: string) => {
    setMode(next);
    onChange(next);
  };
  return (
    <div role="radiogroup" aria-label="Travel mode">
      <ModeButton
        mode="driving"
        name="test-modes"
        icon="D"
        label="Driving"
        active={mode === "driving"}
        onClick={() => choose("driving")}
      />
      <ModeButton
        mode="transit"
        name="test-modes"
        icon="T"
        label="Transit"
        active={mode === "transit"}
        disabled
        onClick={() => choose("transit")}
      />
      <ModeButton
        mode="walking"
        name="test-modes"
        icon="W"
        label="Walking"
        active={mode === "walking"}
        onClick={() => choose("walking")}
      />
    </div>
  );
}

describe("ModeButton radio controls", () => {
  it("skips a disabled mode and selects the next available mode with an arrow key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Modes onChange={onChange} />);
    const driving = screen.getByRole("radio", { name: "Driving" });
    const transit = screen.getByRole("radio", { name: "Transit" });
    const walking = screen.getByRole("radio", { name: "Walking" });
    expect((driving as HTMLInputElement).checked).toBe(true);
    expect((transit as HTMLInputElement).disabled).toBe(true);
    driving.focus();
    await user.keyboard("{ArrowRight}");
    expect((walking as HTMLInputElement).checked).toBe(true);
    expect(onChange).toHaveBeenCalledWith("walking");
    await user.click(transit);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
