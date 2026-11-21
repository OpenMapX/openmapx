import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Stepper } from "./Stepper";

function Controlled({ initial, min, max }: { initial: number; min: number; max: number }) {
  const [value, setValue] = useState(initial);
  return <Stepper label="Guests" value={value} min={min} max={max} onChange={setValue} />;
}

describe("Stepper", () => {
  it("names its group and buttons after the label", () => {
    render(<Stepper label="Rooms" value={2} min={1} max={8} onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Rooms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "-Rooms" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "+Rooms" })).toBeTruthy();
  });

  it("steps within min and max and disables the button at each bound", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={1} min={1} max={2} />);
    const minus = screen.getByRole("button", { name: "-Guests" }) as HTMLButtonElement;
    const plus = screen.getByRole("button", { name: "+Guests" }) as HTMLButtonElement;
    expect(minus.disabled).toBe(true);

    await user.click(plus);
    expect(screen.getByRole("group", { name: "Guests" }).textContent).toContain("2");
    expect(plus.disabled).toBe(true);
    expect(minus.disabled).toBe(false);

    await user.click(minus);
    expect(screen.getByRole("group", { name: "Guests" }).textContent).toContain("1");
  });

  it("works from the keyboard", async () => {
    const user = userEvent.setup();
    render(<Controlled initial={3} min={0} max={9} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "-Guests" }));
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "+Guests" }));
    await user.keyboard(" ");
    await user.keyboard(" ");
    expect(screen.getByRole("group", { name: "Guests" }).textContent).toContain("4");
  });
});
