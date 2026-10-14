import { buildAttributionPresentation } from "@openmapx/core/attribution";
import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDetailChrome } from "@/components/panels/DetailShell";
import { PLACE_DETENTS } from "@/components/panels/sheet/detents";
import { MobileBottomSheet } from "@/components/panels/sheet/MobileBottomSheet";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { getMapObstructionInsets } from "@/lib/mapObstructions";
import { MapFooter } from "./MapFooter";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
if (typeof CSS !== "undefined") CSS.supports = () => false;
class Observer {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver = Observer as unknown as typeof IntersectionObserver;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === "FOOTER") return new DOMRect(0, 747, 390, 97);
    if (this.tagName === "BOTTOM-SHEET")
      return new DOMRect(0, 51 - (Number.parseFloat(this.style.bottom) || 0), 390, 793);
    return original.call(this);
  });
  useMapAttributionStore.setState({
    byLayer: {
      base: [
        buildAttributionPresentation(
          {
            sourceId: "osm",
            name: "OpenStreetMap",
            url: "https://www.openstreetmap.org/copyright",
          },
          "map",
        ),
      ],
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function move(host: HTMLElement, height: number) {
  Object.defineProperties(host, {
    clientHeight: { value: 793, configurable: true },
    scrollHeight: { value: 1586, configurable: true },
    scrollTop: { value: height, configurable: true },
  });
  act(() => {
    host.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
  });
}

it("hands the same focused footer into the real sheet slot before the 97px credits are covered by its 51px map band, then returns them", async () => {
  const { container } = render(
    <>
      <MapFooter />
      <MobileBottomSheet id="detail" zIndex={11} detents={PLACE_DETENTS}>
        <input aria-label="Sheet field" />
      </MobileBottomSheet>
    </>,
  );
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  await act(async () => {
    await customElements.whenDefined("bottom-sheet");
  });
  for (const marker of host.querySelectorAll<HTMLElement>('[slot="snap"]'))
    Object.defineProperty(marker, "offsetTop", { value: 438, configurable: true });
  act(() => window.dispatchEvent(new Event("resize")));
  const footer = container.querySelector("footer") as HTMLElement;
  const button = screen.getByRole("button", { name: "credits" });
  move(host, 180);
  expect(host.contains(footer)).toBe(false);
  act(() => button.focus());
  move(host, 793);
  expect(host.querySelector('[slot="footer"]')?.contains(footer)).toBe(true);
  expect(screen.getByRole("button", { name: "credits" })).toBe(button);
  expect(document.activeElement).toBe(button);
  move(host, 439);
  expect(host.contains(footer)).toBe(false);
  expect(document.activeElement).toBe(button);
  expect(container.querySelectorAll("footer")).toHaveLength(1);
});

async function prepare(container: HTMLElement) {
  await act(async () => {
    await customElements.whenDefined("bottom-sheet");
  });
  for (const marker of container.querySelectorAll<HTMLElement>('[slot="snap"]'))
    Object.defineProperty(marker, "offsetTop", { value: 438, configurable: true });
  act(() => window.dispatchEvent(new Event("resize")));
}

it("keeps the detail above navigation even when navigation registers later, and rehomes on owner removal", async () => {
  const view = (nav: boolean, detail: boolean) => (
    <>
      <MapFooter />
      <div style={{ position: "absolute", zIndex: 1300 }}>
        {nav && (
          <MobileBottomSheet id="nav" zIndex={1} stackLevel={1300} detents={PLACE_DETENTS}>
            <div>Navigation</div>
          </MobileBottomSheet>
        )}
      </div>
      {detail && (
        <MobileBottomSheet id="detail" zIndex={1300} detents={PLACE_DETENTS}>
          <div>Details</div>
        </MobileBottomSheet>
      )}
    </>
  );
  const { container, rerender } = render(view(false, true));
  await prepare(container);
  const footer = container.querySelector("footer") as HTMLElement;
  const detail = container.querySelector("bottom-sheet") as HTMLElement;
  move(detail, 600);
  expect(detail.contains(footer)).toBe(true);
  rerender(view(true, true));
  await prepare(container);
  const nav = container.querySelector("bottom-sheet") as HTMLElement;
  move(nav, 793);
  expect(detail.contains(footer)).toBe(true);
  rerender(view(true, false));
  expect(nav.contains(footer)).toBe(true);
  rerender(view(false, false));
  expect(footer.isConnected).toBe(true);
  expect(container.querySelector("footer")).toBe(footer);
});

it("preserves an open dialog, its title and scroll state through handoff and returns focus to the same trigger", async () => {
  const { container } = render(
    <>
      <MapFooter />
      <MobileBottomSheet id="modal" zIndex={11} detents={PLACE_DETENTS}>
        <input aria-label="Sheet field" />
      </MobileBottomSheet>
    </>,
  );
  await prepare(container);
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  const button = screen.getByRole("button", { name: "credits" });
  act(() => button.click());
  const dialog = screen.getByRole("dialog");
  const title = dialog.getAttribute("aria-labelledby");
  const content = dialog.querySelector(".MuiDialogContent-root") as HTMLElement;
  content.scrollTop = 37;
  const focused = document.activeElement;
  move(host, 793);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect(dialog.getAttribute("aria-labelledby")).toBe(title);
  expect(content.scrollTop).toBe(37);
  expect(document.activeElement).toBe(focused);
  move(host, 180);
  expect(screen.getByRole("dialog")).toBe(dialog);
  move(host, 793);
  act(() => screen.getByRole("button", { name: "close" }).click());
  act(() => vi.advanceTimersByTime(300));
  expect(document.activeElement).toBe(button);
  expect(host.contains(button)).toBe(true);
});

it("does not steal a sheet field's focus and removes the outlet's eligibility while obscured", async () => {
  const view = (obscured: boolean) => (
    <>
      <MapFooter />
      <MobileBottomSheet id="hidden" zIndex={11} detents={PLACE_DETENTS} obscured={obscured}>
        <input aria-label="Sheet field" />
      </MobileBottomSheet>
    </>
  );
  const { container, rerender } = render(view(false));
  await prepare(container);
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  const field = screen.getByRole("textbox");
  act(() => field.focus());
  move(host, 793);
  expect(document.activeElement).toBe(field);
  const footer = host.querySelector("footer") as HTMLElement;
  rerender(view(true));
  expect(host.contains(footer)).toBe(false);
  expect(footer.isConnected).toBe(true);
  rerender(view(false));
  expect(host.contains(footer)).toBe(true);
});

it("reserves only uncovered keyboard pixels for external search and removes that reserve when the sheet itself lifts", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const { container } = render(
    <>
      <input aria-label="Top search" />
      <MapFooter />
      <MobileBottomSheet id="keyboard" zIndex={11} detents={PLACE_DETENTS}>
        <input aria-label="Sheet field" />
      </MobileBottomSheet>
    </>,
  );
  await prepare(container);
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  move(host, 793);
  const footer = host.querySelector("footer");
  const search = screen.getByRole("textbox", { name: "Top search" });
  act(() => search.focus());
  act(() => {
    viewport.height = 500;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(20);
  });
  expect(host.style.bottom).toBe("0px");
  expect(host.style.getPropertyValue("--omx-footer-keyboard-avoidance")).toBe("344px");
  expect(document.activeElement).toBe(search);
  act(() => screen.getByRole("textbox", { name: "Sheet field" }).focus());
  expect(host.style.bottom).toBe("344px");
  expect(host.style.getPropertyValue("--omx-footer-keyboard-avoidance")).toBe("0px");
  expect(host.querySelector("footer")).toBe(footer);
  act(() => {
    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    vi.advanceTimersByTime(20);
  });
  expect(host.style.bottom).toBe("0px");
  expect(host.style.getPropertyValue("--omx-footer-keyboard-avoidance")).toBe("0px");
});

it("recomputes the hypothetical map fit after intrinsic content changes without moving snap markers or alternating owners", async () => {
  const { container } = render(
    <>
      <MapFooter />
      <MobileBottomSheet id="reflow" zIndex={11} detents={PLACE_DETENTS}>
        <div data-omx-peek>Preview</div>
      </MobileBottomSheet>
    </>,
  );
  await prepare(container);
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  const footer = container.querySelector("footer") as HTMLElement;
  const markers = Array.from(host.querySelectorAll('[slot="snap"]'));
  move(host, 439);
  expect(host.contains(footer)).toBe(false);
  let height = 420;
  vi.spyOn(footer, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, 844 - height, 390, height),
  );
  act(() => window.dispatchEvent(new Event("resize")));
  expect(host.contains(footer)).toBe(true);
  for (let index = 0; index < 5; index++) act(() => window.dispatchEvent(new Event("resize")));
  expect(host.contains(footer)).toBe(true);
  expect(Array.from(host.querySelectorAll('[slot="snap"]'))).toEqual(markers);
  height = 97;
  act(() => window.dispatchEvent(new Event("resize")));
  expect(host.contains(footer)).toBe(false);
  expect(footer.isConnected).toBe(true);
});

it("publishes a position-only handoff immediately and keeps attribution when detail actions clear in StrictMode", async () => {
  function Actions({ enabled }: { enabled: boolean }) {
    useDetailChrome(null, enabled ? <button type="button">Directions</button> : null);
    return <div>Body</div>;
  }
  const view = (enabled: boolean) => (
    <StrictMode>
      <MapFooter />
      <MobileBottomSheet id="actions" zIndex={11} detents={PLACE_DETENTS}>
        <Actions enabled={enabled} />
      </MobileBottomSheet>
    </StrictMode>
  );
  const { container, rerender } = render(view(true));
  await prepare(container);
  const host = container.querySelector("bottom-sheet") as HTMLElement;
  const footer = container.querySelector("footer") as HTMLElement;
  vi.spyOn(footer, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, host.contains(footer) ? 747 : 307, 390, 97),
  );
  move(host, 180);
  expect(getMapObstructionInsets().bottom).toBe(537);
  move(host, 793);
  expect(getMapObstructionInsets().bottom).toBe(97);
  expect(screen.getByRole("button", { name: "Directions" })).toBeInTheDocument();
  rerender(view(false));
  expect(screen.queryByRole("button", { name: "Directions" })).toBeNull();
  expect(host.contains(footer)).toBe(true);
  expect(container.querySelectorAll("footer")).toHaveLength(1);
  move(host, 180);
  expect(getMapObstructionInsets().bottom).toBe(537);
});
