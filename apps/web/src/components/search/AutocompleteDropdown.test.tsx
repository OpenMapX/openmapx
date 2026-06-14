import type { AutocompleteResult } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

function makeResult(overrides: Partial<AutocompleteResult> = {}): AutocompleteResult {
  return {
    id: "r1",
    label: "Result one",
    type: "address",
    ...overrides,
  };
}

describe("AutocompleteDropdown", () => {
  it("renders nothing when there are no suggestions", () => {
    const { container } = render(<AutocompleteDropdown suggestions={[]} onSelect={vi.fn()} />);
    expect(container.firstChild).toBe(null);
  });

  it("renders a row per suggestion with label and sublabel", () => {
    const suggestions = [
      makeResult({ id: "a", label: "Berlin", sublabel: "Germany", type: "region" }),
      makeResult({ id: "b", label: "Hamburg", sublabel: "Germany", type: "region" }),
    ];
    render(<AutocompleteDropdown suggestions={suggestions} onSelect={vi.fn()} />);

    expect(screen.queryByText("Berlin")).not.toBe(null);
    expect(screen.queryByText("Hamburg")).not.toBe(null);
    expect(screen.getAllByText("Germany").length).toBe(2);
    expect(screen.getAllByRole("button").length).toBe(2);
  });

  it("invokes onSelect with the clicked suggestion", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const target = makeResult({ id: "poi-1", label: "Coffee Shop", type: "poi" });
    render(
      <AutocompleteDropdown
        suggestions={[makeResult({ id: "other", label: "Other" }), target]}
        onSelect={onSelect}
      />,
    );

    await user.click(screen.getByText("Coffee Shop"));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(target);
  });

  it("marks the highlighted suggestion as selected", () => {
    const suggestions = [
      makeResult({ id: "a", label: "First" }),
      makeResult({ id: "b", label: "Second" }),
    ];
    render(
      <AutocompleteDropdown suggestions={suggestions} onSelect={vi.fn()} highlightedIndex={1} />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons[1].className).toContain("Mui-selected");
    expect(buttons[0].className).not.toContain("Mui-selected");
  });
});
