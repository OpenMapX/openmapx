import type { SavedList, Waypoint } from "@openmapx/core";
import { useDirectionsStore, useSavedPlacesStore } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";

const state = vi.hoisted(() => ({ lists: [] as SavedList[] }));
vi.mock("./panels/saved/ImportPlacesPicker", () => ({ ImportPlacesPicker: () => null }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({ data: state.lists, isLoading: false }),
}));

const { ClickableRow } = await import("./ui/ClickableRow");
const { WaypointList } = await import("./panels/directions/WaypointList");
const { SavedListsTab } = await import("./panels/saved/SavedListsTab");
const { HotelSearchControls } = await import("./panels/place/HotelSearchControls");
const { FlightPanel } = await import("./panels/directions/FlightPanel");

function withIntl(ui: ReactNode) {
  const Wrapper = createQueryWrapper();
  return (
    <Wrapper>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        {ui}
      </NextIntlClientProvider>
    </Wrapper>
  );
}

const initialWaypoints = useDirectionsStore.getState().waypoints;

afterEach(() => {
  useDirectionsStore.setState({ waypoints: initialWaypoints });
});

beforeEach(() => {
  state.lists = [];
  act(() => useSavedPlacesStore.getState().clearSelectedList());
});

describe("ClickableRow", () => {
  it("is a button that Enter and Space activate and that shows a focus ring", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<ClickableRow onClick={onClick}>Open</ClickableRow>);

    await user.tab();
    const row = screen.getByRole("button", { name: "Open" });
    expect(row).toHaveFocus();
    expect(row.classList.contains("Mui-focusVisible")).toBe(true);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
  });
});

describe("keyboard-only flows", () => {
  function Stops({ onAdd, onReverse }: { onAdd: () => void; onReverse: () => void }) {
    const t = useTranslations("directions");
    const waypoints: Waypoint[] = [
      { id: "a", coords: [13.4, 52.5], label: "Berlin", type: "origin" },
      { id: "b", coords: [11.6, 48.1], label: "Munich", type: "destination" },
    ];
    return (
      <WaypointList
        waypoints={waypoints}
        inputValues={["Berlin", "Munich"]}
        onInputChange={() => {}}
        onFocus={() => {}}
        onBlur={() => {}}
        onReorder={() => {}}
        onAdd={onAdd}
        onRemove={() => {}}
        onReverse={onReverse}
        t={t}
      />
    );
  }

  it("adds a stop and swaps the ends from the keyboard", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    const onReverse = vi.fn();
    render(withIntl(<Stops onAdd={onAdd} onReverse={onReverse} />));

    const addStop = screen.getByRole("button", { name: en.directions.addStop });
    while (document.activeElement !== addStop) await user.tab();
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenCalledWith(0);

    screen.getByRole("button", { name: en.directions.swap }).focus();
    await user.keyboard("{Enter}");
    expect(onReverse).toHaveBeenCalledTimes(1);
  });

  it("opens a saved list from the keyboard, with its options next in the tab order", async () => {
    const user = userEvent.setup();
    state.lists = [
      { id: "trip", name: "Trip", icon: null, isPrivate: true, placeCount: 2 } as SavedList,
    ];
    render(withIntl(<SavedListsTab />));

    const row = screen.getByRole("button", { name: /^Trip/ });
    const options = screen.getByRole("button", {
      name: en.saved.itemOptions.replace("{name}", "Trip"),
    });
    expect(row.contains(options)).toBe(false);
    while (document.activeElement !== row) await user.tab();
    await user.tab();
    expect(options).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: en.saved.deleteList })).toBeVisible();
    expect(useSavedPlacesStore.getState().selectedListId).toBeNull();
    await user.keyboard("{Escape}");

    row.focus();
    await user.keyboard("{Enter}");
    expect(useSavedPlacesStore.getState().selectedListId).toBe("trip");
  });
});

describe("accessible names", () => {
  it("names the hotel date fields", () => {
    render(withIntl(<HotelSearchControls />));
    expect(screen.getByLabelText(en.place.checkIn)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(en.place.checkOut)).toHaveAttribute("type", "date");
  });

  it("names the flight date and cabin fields and exposes the toggles' state", async () => {
    const user = userEvent.setup();
    act(() =>
      useDirectionsStore.setState({
        waypoints: [
          { id: "from", coords: [13.4, 52.5], label: "Berlin", type: "origin" },
          { id: "to", coords: [2.35, 48.86], label: "Paris", type: "destination" },
        ],
      }),
    );
    render(withIntl(<FlightPanel />));
    expect(screen.getByLabelText(en.directions.departDate)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(en.directions.returnDateLabel)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(en.directions.cabin).tagName).toBe("SELECT");

    const oneWay = screen.getByRole("button", { name: en.directions.oneWay });
    expect(oneWay).toHaveAttribute("aria-pressed", "false");
    oneWay.focus();
    await user.keyboard("{Enter}");
    expect(oneWay).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText(en.directions.returnDateLabel)).not.toBeInTheDocument();

    const directOnly = screen.getByRole("checkbox", { name: en.directions.directOnly });
    directOnly.focus();
    await user.keyboard(" ");
    expect(directOnly).toHaveAttribute("aria-checked", "true");
    // The nearest-airport lookup fails here; the empty airport fields must not take focus.
    await waitFor(() =>
      expect(screen.getAllByRole("textbox", { name: /^(From|To)$/ })).toHaveLength(2),
    );
    expect(directOnly).toHaveFocus();
    expect(within(document.body).queryAllByRole("button", { name: "" })).toHaveLength(0);
  });
});
