import { categoryPlaceToPlace, PANEL, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { usePinMarker } from "@/hooks/usePinMarker";
import { SelectedPlaceMarker } from "./SelectedPlaceMarker";

vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));

it("reopens the place detail when the selected pin is activated", () => {
  usePlaceStore.setState({
    selectedPlace: categoryPlaceToPlace({
      id: "osm:node/1",
      name: "Cafe",
      coordinates: [8, 50],
    }),
  });
  useSidebarStore.getState().closeDetail();
  const view = render(<SelectedPlaceMarker />);
  const pinHook = usePinMarker as unknown as ReturnType<typeof vi.fn>;
  const onPinClick = pinHook.mock.calls.at(-1)?.[4] as (() => void) | undefined;
  expect(onPinClick).toBeTypeOf("function");
  act(() => onPinClick?.());
  expect(useSidebarStore.getState().activeDetailId).toBe(PANEL.PLACE_CARD);
  view.unmount();
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.getState().closeDetail();
});
