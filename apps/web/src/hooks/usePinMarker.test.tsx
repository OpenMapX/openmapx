import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { createFakeMap } from "@/test";
import { usePinMarker } from "./usePinMarker";

const fake = createFakeMap({ styleLoaded: true });
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: fake.map }, mapReady: true }),
}));
vi.mock("maplibre-gl", () => ({
  Marker: class {
    element: HTMLElement;
    constructor({ element }: { element: HTMLElement }) {
      this.element = element;
    }
    setLngLat() {
      return this;
    }
    addTo(map: { getCanvasContainer: () => HTMLElement }) {
      map.getCanvasContainer().appendChild(this.element);
      return this;
    }
    remove() {
      this.element.remove();
    }
  },
}));

function Pin({ onClick }: { onClick?: () => void }) {
  usePinMarker([8, 50], "Cafe", true, undefined, onClick);
  return null;
}

it("activates a focused pin by pointer and keyboard", async () => {
  const onClick = vi.fn();
  const view = render(<Pin onClick={onClick} />);
  await act(async () => {});
  const pin = fake.map.getCanvasContainer().querySelector<HTMLElement>("[role='button']");
  expect(pin?.tabIndex).toBe(0);
  expect(pin?.getAttribute("aria-label")).toBe("Cafe");
  const label = pin?.querySelector("span");
  expect(label?.parentElement?.style.pointerEvents).toBe("auto");
  expect(label?.parentElement?.style.left).toBe("20px");
  fireEvent.click(pin as HTMLElement);
  fireEvent.click(label as HTMLElement);
  fireEvent.keyDown(pin as HTMLElement, { key: "Enter" });
  fireEvent.keyDown(pin as HTMLElement, { key: " " });
  expect(onClick).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(fake.map.getCanvasContainer().querySelector("[role='button']")).toBeNull();
});

it("keeps a label without an activation handler transparent to map pointers", async () => {
  const view = render(<Pin />);
  await act(async () => {});
  const pin = fake.map.getCanvasContainer().querySelector<HTMLElement>("div");
  const label = pin?.querySelector("span");
  expect(label?.parentElement?.style.pointerEvents).toBe("none");
  view.unmount();
});
