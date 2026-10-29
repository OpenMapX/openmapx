import { vi } from "vitest";

/** Deterministic DOM geometry and resize delivery for measured-layout regressions. */
export function installMeasuredLayout(rectFor: (element: HTMLElement) => DOMRect) {
  const observers = new Set<Observer>();
  class Observer implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    deliver() {
      const entries: ResizeObserverEntry[] = [];
      for (const target of this.targets) {
        if (!(target instanceof HTMLElement)) continue;
        const contentRect = rectFor(target);
        const size = { inlineSize: contentRect.width, blockSize: contentRect.height };
        entries.push({
          target,
          contentRect,
          contentBoxSize: [size],
          borderBoxSize: [size],
          devicePixelContentBoxSize: [size],
        });
      }
      this.callback(entries, this);
    }
    disconnect() {
      this.targets.clear();
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
      for (const observer of [...observers]) observer.deliver();
    },
    restore: () => {
      rectSpy.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}
