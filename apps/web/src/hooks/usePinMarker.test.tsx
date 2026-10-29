import { useParkingStore } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { act, fireEvent, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { publishMapObstruction } from "@/lib/mapObstructions";
import { createFakeMap } from "@/test";
import { usePinMarker } from "./usePinMarker";

const fake = createFakeMap({ styleLoaded: true });
Object.assign(fake.map.getContainer(), {
  getBoundingClientRect: () => new DOMRect(0, 0, 1200, 800),
});
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

function Pin({
  onClick,
  label = "Cafe",
  contributors = [],
  labelContributors,
}: {
  onClick?: () => void;
  label?: string;
  contributors?: readonly Attribution[];
  labelContributors?: readonly Attribution[];
}) {
  usePinMarker([8, 50], label, true, undefined, onClick, contributors, labelContributors);
  return null;
}

it("lets an owned pointer click bubble without activating the pin", async () => {
  const onClick = vi.fn();
  const capture = vi.fn((...args: unknown[]) => {
    const event = args[0] as MouseEvent;
    useParkingStore.getState().setPickedCoords([8, 50]);
    // The same DOM event may also reach a delegated MapLibre wrapper afterward.
    fake.emit("click", { originalEvent: event });
  });
  const container = fake.map.getCanvasContainer();
  container.addEventListener("click", capture);
  const view = render(<Pin onClick={onClick} />);
  await act(async () => {});
  const pin = container.querySelector<HTMLElement>("[role='button']");
  useParkingStore.getState().setPicking(true);
  fireEvent.click(pin as HTMLElement);
  expect(onClick).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledTimes(1);
  expect(useParkingStore.getState().pickedCoords).toEqual([8, 50]);
  container.removeEventListener("click", capture);
  fireEvent.click(pin as HTMLElement);
  expect(onClick).toHaveBeenCalledTimes(1);
  view.unmount();
  useParkingStore.getState().reset();
});

it("activates a focused pin by pointer and keyboard", async () => {
  const onClick = vi.fn();
  const view = render(<Pin onClick={onClick} />);
  await act(async () => {});
  const pin = fake.map.getCanvasContainer().querySelector<HTMLElement>("[role='button']");
  expect(pin?.tabIndex).toBe(0);
  expect(pin?.getAttribute("aria-label")).toBe("Cafe");
  const label = pin?.querySelector("span");
  expect(label?.parentElement?.style.pointerEvents).toBe("auto");
  expect(label?.parentElement?.style.left).toBe("26px");
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
  expect(label.parentElement?.style.right).toBe("26px");
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
  expect(label.parentElement?.style.right).toBe("26px");

  act(() => publishMapObstruction("pin-test-sidebar", "left", 250));
  await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(label.parentElement?.style.left).toBe("26px");
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

it("credits the actual DOM pin after async creation without querying features, then removes offscreen or detached credit", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const canvas = document.createElement("div");
  container.append(canvas);
  document.body.append(container);
  container.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  const getContainer = vi.spyOn(fake.map, "getContainer").mockReturnValue(container);
  const getCanvas = vi.spyOn(fake.map, "getCanvasContainer").mockReturnValue(canvas);
  const view = render(
    <Pin onClick={() => {}} contributors={[{ sourceId: "pin", name: "DOM pin supplier" }]} />,
  );
  try {
    await act(async () => {});
    const pin = canvas.querySelector<HTMLElement>("[role='button']");
    expect(pin).not.toBeNull();
    let rect = new DOMRect(100, 100, 20, 32);
    if (pin) pin.getBoundingClientRect = () => rect;
    fake.state.styleLoaded = false;
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const html = () =>
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => entry.fullHtml)
        .join(" ");
    expect(html()).toContain("DOM pin supplier");
    rect = new DOMRect(401, 100, 20, 32);
    await act(async () => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    expect(html()).not.toContain("DOM pin supplier");
    rect = new DOMRect(100, 100, 20, 32);
    await act(async () => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    expect(html()).toContain("DOM pin supplier");
    view.unmount();
    expect(html()).not.toContain("DOM pin supplier");
  } finally {
    view.unmount();
    getContainer.mockRestore();
    getCanvas.mockRestore();
    container.remove();
    fake.state.styleLoaded = true;
    vi.useRealTimers();
  }
});

it("publishes native pin geometry and only the measured visible text channel through the shared scheduler", async () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  const canvas = document.createElement("div");
  container.append(canvas);
  document.body.append(container);
  container.getBoundingClientRect = () => new DOMRect(0, 0, 400, 300);
  const getContainer = vi.spyOn(fake.map, "getContainer").mockReturnValue(container);
  const getCanvas = vi.spyOn(fake.map, "getCanvasContainer").mockReturnValue(canvas);
  const view = render(
    <Pin
      onClick={() => {}}
      contributors={[{ sourceId: "coords", name: "Coordinate supplier" }]}
      labelContributors={[{ sourceId: "name", name: "Name supplier" }]}
    />,
  );
  let rootRect = new DOMRect(100, 100, 20, 32),
    textRect = new DOMRect(120, 100, 0, 16);
  const range = vi
    .spyOn(document, "createRange")
    .mockImplementation(
      () =>
        ({ selectNodeContents: () => {}, getClientRects: () => [textRect] }) as unknown as Range,
    );
  try {
    await act(async () => {});
    const pin = canvas.querySelector<HTMLElement>("[role='button']");
    if (!pin) throw new Error("Native pin was not created");
    pin.getBoundingClientRect = () => rootRect;
    const geometry = pin.querySelector("svg");
    if (!geometry) throw new Error("Native pin geometry was not created");
    geometry.getBoundingClientRect = () => rootRect;
    const label = pin.querySelector("span");
    if (!label) throw new Error("Native label was not created");
    label.getBoundingClientRect = () => textRect;
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const html = () =>
      Object.values(useMapAttributionStore.getState().byLayer)
        .flat()
        .map((entry) => entry.fullHtml)
        .join(" ");
    expect(html()).toContain("Coordinate supplier");
    expect(html()).not.toContain("Name supplier");
    textRect = new DOMRect(120, 100, 100, 16);
    await act(async () => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    expect(html()).toContain("Name supplier");
    rootRect = new DOMRect(-30, 100, 20, 32);
    textRect = new DOMRect(10, 100, 100, 16);
    await act(async () => {
      fake.emit("render");
      vi.advanceTimersByTime(250);
    });
    expect(html()).not.toContain("Coordinate supplier");
    expect(html()).toContain("Name supplier");
    view.unmount();
    expect(html()).not.toContain("Name supplier");
  } finally {
    view.unmount();
    range.mockRestore();
    getContainer.mockRestore();
    getCanvas.mockRestore();
    container.remove();
    vi.useRealTimers();
  }
});
