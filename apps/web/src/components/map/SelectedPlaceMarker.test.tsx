import { categoryPlaceToPlace, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePinMarker } from "@/hooks/usePinMarker";
import { SelectedPlaceMarker } from "./SelectedPlaceMarker";

vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));

afterEach(() => {
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  vi.clearAllMocks();
});

it("keeps the selected pin's place in the full sidebar", () => {
  usePlaceStore.setState({
    selectedPlace: categoryPlaceToPlace({
      id: "osm:node/1",
      name: "Cafe",
      coordinates: [8, 50],
    }),
  });
  useSidebarStore.setState({
    activeSidebarId: PANEL.PLACE,
    activeDetailId: null,
    collapsed: false,
  });
  const view = render(<SelectedPlaceMarker />);
  const pinHook = usePinMarker as unknown as ReturnType<typeof vi.fn>;
  const onPinClick = pinHook.mock.calls.at(-1)?.[4] as (() => void) | undefined;
  expect(onPinClick).toBeTypeOf("function");
  act(() => onPinClick?.());
  expect(useSidebarStore.getState()).toMatchObject({
    activeSidebarId: PANEL.PLACE,
    activeDetailId: null,
  });
  view.unmount();
});

it("opens the card beside a visible category sidebar", () => {
  usePlaceStore.setState({
    selectedPlace: categoryPlaceToPlace({ id: "osm:node/1", name: "Cafe", coordinates: [8, 50] }),
  });
  useSidebarStore.setState({
    activeSidebarId: PANEL.CATEGORY,
    activeDetailId: null,
    collapsed: false,
  });
  const view = render(<SelectedPlaceMarker />);
  const pinHook = usePinMarker as unknown as ReturnType<typeof vi.fn>;
  const onPinClick = pinHook.mock.calls.at(-1)?.[4] as (() => void) | undefined;
  act(() => onPinClick?.());
  expect(useSidebarStore.getState()).toMatchObject({
    activeSidebarId: PANEL.CATEGORY,
    activeDetailId: PANEL.PLACE_CARD,
  });
  view.unmount();
});
