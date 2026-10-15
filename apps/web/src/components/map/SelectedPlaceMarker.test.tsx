import {
  categoryPlaceToPlace,
  createPlace,
  PANEL,
  type Place,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import {
  captureSavedPlaceContributors,
  savedPlaceContributorsForPlace,
} from "@openmapx/core/saved-place-contributors";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePinMarker } from "@/hooks/usePinMarker";
import { SelectedPlaceMarker } from "./SelectedPlaceMarker";
import { useHiddenStylePoi } from "./useHiddenStylePoi";

const merged = vi.hoisted(() => ({ place: null as Place | null }));

vi.mock("@/hooks/usePinMarker", () => ({ usePinMarker: vi.fn() }));
vi.mock("./useHiddenStylePoi", () => ({ useHiddenStylePoi: vi.fn() }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useMergedPlace: (selected: Place | null) => ({
    place: merged.place ?? selected,
    isLoading: false,
  }),
}));

afterEach(() => {
  merged.place = null;
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

it("labels the pin with the place panel's title and hides the basemap's own label", () => {
  const selected = createPlace({
    primaryScheme: "stylePoi",
    ids: { stylePoi: "5564352411" },
    name: "Berliner Fernsehturm",
    address: "Berliner Fernsehturm",
    coordinates: [13.4094, 52.5208],
  });
  merged.place = { ...selected, name: "Fernsehturm Berlin" };
  usePlaceStore.setState({ selectedPlace: selected });

  const view = render(<SelectedPlaceMarker />);

  const pinHook = usePinMarker as unknown as ReturnType<typeof vi.fn>;
  expect(pinHook.mock.calls.at(-1)?.[1]).toBe("Fernsehturm Berlin");
  const hideHook = useHiddenStylePoi as unknown as ReturnType<typeof vi.fn>;
  expect(hideHook.mock.calls.at(-1)?.[0]).toEqual({
    coordinates: [13.4094, 52.5208],
    names: ["Berliner Fernsehturm", "Fernsehturm Berlin"],
    stylePoiId: "5564352411",
  });
  view.unmount();
});

it("stops hiding the basemap label once nothing is selected", () => {
  const view = render(<SelectedPlaceMarker />);

  const hideHook = useHiddenStylePoi as unknown as ReturnType<typeof vi.fn>;
  expect(hideHook.mock.calls.at(-1)?.[0]).toBeNull();
  view.unmount();
});

it("keeps native geometry and visible-name channels separate with the merged name owner", () => {
  const coordinate = { sourceId: "coordinate", name: "Coordinate supplier" };
  const name = { sourceId: "name", name: "Merged name supplier" };
  const hidden = { sourceId: "hidden", name: "Discarded name supplier" };
  const selected = createPlace({
    primaryScheme: "osm",
    ids: { osm: "node/8" },
    name: "Selected",
    address: "",
    coordinates: [8, 50],
    fieldContributors: { coordinates: [coordinate], name: [hidden] },
  });
  merged.place = {
    ...selected,
    name: "Merged",
    fieldContributors: { name: [name], coordinates: [] },
  };
  usePlaceStore.setState({ selectedPlace: selected });
  const view = render(<SelectedPlaceMarker />);
  const args = (usePinMarker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
  expect(args?.[5]).toEqual([coordinate]);
  expect(args?.[6]).toEqual([coordinate, name]);
  view.unmount();
});

it("credits known coordinate components on a partial saved selection without inventing an unknown axis", () => {
  const latitude = { sourceId: "latitude", name: "Latitude supplier" };
  const selected = createPlace({
    primaryScheme: "saved",
    ids: { saved: "partial" },
    name: "Saved point",
    address: "",
    coordinates: [8, 50],
    ...savedPlaceContributorsForPlace({ lat: [latitude], name: [] }),
  });
  usePlaceStore.setState({ selectedPlace: selected });
  const view = render(<SelectedPlaceMarker />);
  const args = (usePinMarker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
  expect(args?.[5]).toEqual([latitude]);
  expect(args?.[6]).toEqual([latitude]);
  expect(captureSavedPlaceContributors(selected)).toEqual({ lat: [latitude], name: [] });
  view.unmount();
});

it("respects child axis overrides while retaining the other axis parent capture", () => {
  const latitude = { sourceId: "latitude", name: "Parent coordinate supplier" };
  const longitude = { sourceId: "longitude", name: "Longitude override" };
  const selected = createPlace({
    primaryScheme: "saved",
    ids: { saved: "axes" },
    name: "Saved point",
    address: "",
    coordinates: [8, 50],
    fieldContributors: { coordinates: [latitude], "coordinates.0": [longitude], name: [] },
  });
  usePlaceStore.setState({ selectedPlace: selected });
  const view = render(<SelectedPlaceMarker />);
  const args = (usePinMarker as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
  expect(args?.[5]).toEqual([longitude, latitude]);
  expect(args?.[6]).toEqual([longitude, latitude]);
  view.unmount();
});
