import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { createFakeMap } from "@/test";
import { usePinMarker } from "./usePinMarker";

const fake = createFakeMap({ styleLoaded: true });
const mapRef = { current: fake.map };
let styleVersion = 0;
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef, mapReady: true, styleVersion }),
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

function Pin({ onClick, label = "Cafe" }: { onClick?: () => void; label?: string }) {
  usePinMarker([8, 50], label, true, undefined, onClick);
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

it("shortens a long pin label before it runs under the map controls", async () => {
  const controls = document.createElement("div");
  controls.dataset.mapControlsColumns = "1";
  let controlsLeft = 342;
  controls.getBoundingClientRect = () => new DOMRect(controlsLeft, 188, 36, 196);
  document.body.appendChild(controls);
  fake.map.getContainer().getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);

  const view = render(<Pin label="S+U Alexanderplatz/Memhardstraße" />);
  await act(async () => {});
  const pin = fake.map.getCanvasContainer().querySelector<HTMLElement>("div");
  const label = pin?.querySelector<HTMLSpanElement>("span");
  if (!pin || !label) throw new Error("Pin label was not rendered");
  pin.getBoundingClientRect = () => new DOMRect(157, 237, 20, 32);
  label.getBoundingClientRect = () => new DOMRect(177, 242, 200, 21);
  Object.defineProperty(label, "scrollWidth", { configurable: true, value: 230 });

  act(() => fake.emit("move"));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

  expect(label.style.maxWidth).toBe("157px");
  controlsLeft = 300;
  act(() => fireEvent.transitionEnd(controls, { propertyName: "bottom" }));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(label.parentElement?.style.right).toBe("20px");
  expect(label.style.maxWidth).toBe("149px");
  view.unmount();
  controls.remove();
});

it("refits a label when a sidebar opens without moving the map", async () => {
  fake.map.getContainer().getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
  const view = render(<Pin label="S+U Alexanderplatz/Memhardstraße" />);
  await act(async () => {});
  const pin = fake.map.getCanvasContainer().querySelector<HTMLElement>("div");
  const label = pin?.querySelector<HTMLSpanElement>("span");
  if (!pin || !label) throw new Error("Pin label was not rendered");
  pin.getBoundingClientRect = () => new DOMRect(300, 237, 20, 32);
  label.getBoundingClientRect = () => new DOMRect(320, 242, 200, 21);
  Object.defineProperty(label, "scrollWidth", { configurable: true, value: 230 });
  act(() => fake.emit("move"));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(label.parentElement?.style.right).toBe("20px");

  act(() => publishMapObstruction("pin-test-sidebar", "left", 250));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(label.parentElement?.style.left).toBe("20px");
  expect(label.style.maxWidth).toBe("62px");

  view.unmount();
  publishMapObstruction("pin-test-sidebar", "left", null);
});

it("reattaches the pin after the map is replaced by a retry", async () => {
  const view = render(<Pin label="Station" />);
  await act(async () => {});
  expect(fake.map.getCanvasContainer().querySelector("span")?.textContent).toBe("Station");

  const replacement = createFakeMap({ styleLoaded: true });
  mapRef.current = replacement.map;
  styleVersion++;
  view.rerender(<Pin label="Station" />);
  await act(async () => {});

  expect(fake.map.getCanvasContainer().querySelector("span")).toBeNull();
  expect(replacement.map.getCanvasContainer().querySelector("span")?.textContent).toBe("Station");
  view.unmount();
  mapRef.current = fake.map;
  styleVersion = 0;
});
