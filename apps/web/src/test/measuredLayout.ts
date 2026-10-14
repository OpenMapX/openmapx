import { vi } from "vitest";

/** Deterministic DOM geometry and resize delivery for measured-layout regressions. */
export function installMeasuredLayout(rectFor: (element: HTMLElement) => DOMRect) {
  const observers = new Set<Observer>();
  class Observer {
    constructor(readonly callback: () => void) {
      observers.add(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      observers.delete(this);
    }
  }
  vi.stubGlobal("ResizeObserver", Observer);
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return rectFor(this);
    });
  return {
    resize: () => {
      for (const observer of [...observers]) observer.callback();
    },
    restore: () => {
      rectSpy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}
