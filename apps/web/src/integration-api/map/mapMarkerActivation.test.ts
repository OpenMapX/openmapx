// @vitest-environment jsdom

import { useParkingStore } from "@openmapx/core";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapClickOwner } from "./mapClickOwnership";
import { bindMapMarkerActivation } from "./mapMarkerActivation";

// Stands in for MapLibre's canvas container: marker elements are mounted inside
// it, and the map turns a click that reaches it into a map `click`.
let mapContainer: HTMLElement;
let marker: HTMLElement;
let mapClicks: Array<string | null>;
let documentClicks: number;

beforeEach(() => {
  useParkingStore.getState().reset();
  mapContainer = document.createElement("div");
  marker = document.createElement("div");
  marker.append(document.createElement("span"));
  mapContainer.append(marker);
  document.body.append(mapContainer);
  mapClicks = [];
  mapContainer.addEventListener("click", (event) => mapClicks.push(getMapClickOwner(event)));
  mapContainer.addEventListener("keydown", () => mapClicks.push("key"));
  documentClicks = 0;
  document.addEventListener("click", countDocumentClick);
});

function countDocumentClick() {
  documentClicks += 1;
}

afterEach(() => {
  document.removeEventListener("click", countDocumentClick);
  mapContainer.remove();
  useParkingStore.getState().reset();
});

describe("bindMapMarkerActivation", () => {
  it("activates the marker and claims the click from the map", () => {
    const onActivate = vi.fn();
    bindMapMarkerActivation(marker, { onActivate });

    (marker.firstElementChild as HTMLElement).click();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(mapClicks).toEqual(["marker"]);
  });

  it("still lets the click reach listeners outside the map", () => {
    bindMapMarkerActivation(marker, { onActivate: () => undefined });

    marker.click();

    expect(documentClicks).toBe(1);
  });

  it("claims the click when there is nothing to activate", () => {
    bindMapMarkerActivation(marker);

    marker.click();

    expect(mapClicks).toEqual(["marker"]);
  });

  it("leaves a picker-owned click to the map without activating", () => {
    const onActivate = vi.fn();
    bindMapMarkerActivation(marker, { onActivate });
    useParkingStore.getState().setPicking(true);

    marker.click();

    expect(onActivate).not.toHaveBeenCalled();
    expect(mapClicks).toEqual(["parking"]);
  });

  it("is see-through while disabled", () => {
    const onActivate = vi.fn();
    let enabled = false;
    bindMapMarkerActivation(marker, { onActivate, isEnabled: () => enabled });

    marker.click();
    fireEvent.keyDown(marker, { key: "Enter" });
    expect(onActivate).not.toHaveBeenCalled();
    expect(mapClicks).toEqual([null, "key"]);

    enabled = true;
    marker.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(mapClicks).toEqual([null, "key", "marker"]);
  });

  it.each(["Enter", " "])("activates on %j without passing the key on", (key) => {
    const onActivate = vi.fn();
    bindMapMarkerActivation(marker, { onActivate });

    const handled = !fireEvent.keyDown(marker, { key });

    expect(handled).toBe(true);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(mapClicks).toEqual([]);
  });

  it("activates from the keyboard even while a picker is active", () => {
    const onActivate = vi.fn();
    bindMapMarkerActivation(marker, { onActivate });
    useParkingStore.getState().setPicking(true);

    fireEvent.keyDown(marker, { key: "Enter" });

    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", () => {
    const onActivate = vi.fn();
    bindMapMarkerActivation(marker, { onActivate });

    fireEvent.keyDown(marker, { key: "a" });

    expect(onActivate).not.toHaveBeenCalled();
    expect(mapClicks).toEqual(["key"]);
  });
});
