import type { AutocompleteResult } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";
import { AutocompleteDropdown } from "./AutocompleteDropdown";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

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
    expect(screen.getAllByText("search.resultTypeArea · Germany").length).toBe(2);
    expect(screen.getAllByRole("button").length).toBe(2);
  });

  it("removes repeated names and address parts from the displayed place description", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            label: "Aachen Hauptbahnhof",
            sublabel: "Aachen Hauptbahnhof, Lagerhausstrasse, Aachen, Aachen, Germany",
            type: "poi",
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypePlace · Lagerhausstrasse, Aachen, Germany");
    expect(screen.queryByText(/Aachen Hauptbahnhof, Lagerhausstrasse/)).toBeNull();
  });

  it("shows a transit type when a place has an authoritative transit category", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            id: "station",
            label: "Aachen Hauptbahnhof",
            sublabel: "Aachen Hauptbahnhof, Lagerhausstrasse, Aachen, Germany",
            type: "poi",
            rawCategory: "railway/station",
          }),
          makeResult({
            id: "office",
            label: "Airport Center",
            sublabel: "Airport Center, Main Street, Frankfurt, Germany",
            type: "poi",
            rawCategory: "office",
          }),
          makeResult({
            id: "bus-stop",
            label: "Aachen Hauptbahnhof Bus",
            sublabel: "Aachen Hauptbahnhof Bus, Aachen, Germany",
            type: "street",
            rawCategory: "highway/bus_stop",
          }),
          makeResult({
            id: "signal-box",
            label: "Aachen Hbf ESTW-A",
            sublabel: "Aachen Hbf ESTW-A, Aachen, Germany",
            type: "poi",
            rawCategory: "railway/signal_box",
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypeStop · Lagerhausstrasse, Aachen, Germany");
    screen.getByText("search.resultTypePlace · Main Street, Frankfurt, Germany");
    screen.getByText("search.resultTypeStop · Aachen, Germany");
    screen.getByText("search.resultTypePlace · Aachen, Germany");
  });

  it("keeps different localities visible for places with the same name", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({ id: "one", label: "Springfield", sublabel: "Springfield, Illinois, USA" }),
          makeResult({ id: "two", label: "Springfield", sublabel: "Springfield, Missouri, USA" }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypeAddress · Illinois, USA");
    screen.getByText("search.resultTypeAddress · Missouri, USA");
  });

  it("shows a distance from the known user location without changing the address", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            label: "Central Cafe",
            sublabel: "Station Road, Aachen",
            type: "poi",
            coordinates: [6.084, 50.775],
          }),
        ]}
        distanceReference={{ kind: "user_location", coordinates: [6.084, 50.775] }}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypePlace · Station Road, Aachen · 0 m search.fromYou");
  });

  it("uses the map center only without a user fix and leaves unknown positions unmeasured", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({ id: "near", label: "Near", coordinates: [6.084, 50.775] }),
          makeResult({ id: "unknown", label: "Unknown" }),
        ]}
        distanceReference={{ kind: "search_area_center", coordinates: [6.084, 50.775] }}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypeAddress · 0 m search.fromMapCenter");
    expect(screen.getByRole("button", { name: /Unknown/ }).textContent).not.toContain(
      "fromMapCenter",
    );
  });

  it("shows the place type without an address and preserves unfamiliar address formats", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({ id: "one", label: "Riverside", sublabel: undefined, type: "street" }),
          makeResult({
            id: "two",
            label: "Old Mill",
            sublabel: "Near the old bridge,  upstairs",
            type: "poi",
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.resultTypeStreet");
    expect(screen.getAllByRole("button")[1].querySelector("p")?.textContent).toBe(
      "search.resultTypePlace · Near the old bridge,  upstairs",
    );
  });

  it("distinguishes category and brand actions from concrete places", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            id: "category",
            label: "Coffee",
            type: "category",
            sublabel: "search.searchCategory",
          }),
          makeResult({ id: "brand", label: "Coffee Co", type: "brand", sublabel: "Coffee shops" }),
          makeResult({
            id: "place",
            label: "Coffee Co",
            type: "poi",
            sublabel: "Main Street, Aachen",
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    screen.getByText("search.searchCategory");
    screen.getByText("search.searchBrand · Coffee shops");
    screen.getByText("search.resultTypePlace · Main Street, Aachen");
  });

  it("selects the original suggestion object and full address after display shortening", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const suggestion = makeResult({
      label: "Aachen Hauptbahnhof",
      sublabel: "Aachen Hauptbahnhof, Lagerhausstrasse, Aachen, Germany",
      type: "poi",
    });
    render(<AutocompleteDropdown suggestions={[suggestion]} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Aachen Hauptbahnhof/ }));

    expect(onSelect).toHaveBeenCalledWith(suggestion);
    expect(onSelect.mock.calls[0]?.[0]).toBe(suggestion);
    expect(suggestion.sublabel).toBe("Aachen Hauptbahnhof, Lagerhausstrasse, Aachen, Germany");
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

  it("shows a compact matched-value badge and exposes it in the row name", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            id: "oa:EDDF",
            label: "Frankfurt am Main Airport",
            type: "poi",
            searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("FRA").className).toContain("MuiChip-label");
    screen.getByRole("button", { name: /Frankfurt am Main Airport.*FRA/i });
  });

  it("does not render an empty or redundant badge for an ordinary result", () => {
    render(
      <AutocompleteDropdown
        suggestions={[
          makeResult({
            label: "Berlin",
            searchMatch: { kind: "name", value: "Berlin", normalized: "berlin" },
          }),
        ]}
        onSelect={vi.fn()}
      />,
    );

    expect(document.querySelector(".MuiChip-root")).toBeNull();
  });

  it("returns the unchanged canonical label when a badge row is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const suggestion = makeResult({
      id: "oa:EDDF",
      label: "Frankfurt am Main Airport",
      type: "poi",
      searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
    });
    render(<AutocompleteDropdown suggestions={[suggestion]} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: /Frankfurt am Main Airport.*FRA/i }));

    const selected = onSelect.mock.calls[0]?.[0] as AutocompleteResult;
    expect(selected.label).toBe("Frankfurt am Main Airport");
  });
});
