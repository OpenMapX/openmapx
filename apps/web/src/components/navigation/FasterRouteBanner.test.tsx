import { useNavigationStore } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FasterRouteBanner } from "./FasterRouteBanner";

const speak = vi.fn();
vi.mock("@/lib/navigation/useNavigationVoice", () => ({
  useNavigationVoice: () => speak,
}));

const routeOf = (summary: string) => ({
  distance: 1000,
  duration: 2700,
  geometry: [
    [0, 0],
    [0.01, 0],
  ] as [number, number][],
  legs: [],
  steps: [],
  mode: "driving" as const,
  summary,
});

const renderBanner = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <FasterRouteBanner />
    </NextIntlClientProvider>,
  );

const propose = () =>
  useNavigationStore.getState().proposeFasterRoute({
    route: routeOf("via A61"),
    alternatives: [],
    savedSeconds: 720,
    proposedAtMs: Date.now(),
  });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  speak.mockReset();
  useNavigationStore.getState().stopNavigation();
  useNavigationStore.getState().startGroundNavigation(routeOf("via A46"), "driving", [
    [0, 0],
    [0.01, 0],
  ]);
});

afterEach(() => {
  vi.useRealTimers();
  useNavigationStore.getState().stopNavigation();
});

describe("FasterRouteBanner", () => {
  it("renders nothing with no proposal", () => {
    renderBanner();
    expect(screen.queryByTestId("faster-route-banner")).toBeNull();
  });

  it("shows the saving and the road", () => {
    propose();
    renderBanner();
    const el = screen.getByTestId("faster-route-banner");
    expect(el.textContent).toContain("12 min");
    expect(el.textContent).toContain("A61");
  });

  it("announces once, not on every render", () => {
    propose();
    const { rerender } = renderBanner();
    rerender(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <FasterRouteBanner />
      </NextIntlClientProvider>,
    );
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it("auto-accepts after ten seconds", () => {
    propose();
    renderBanner();
    act(() => {
      vi.advanceTimersByTime(10_100);
    });
    expect(useNavigationStore.getState().route?.summary).toBe("via A61");
    expect(useNavigationStore.getState().fasterRoute).toBeNull();
  });

  it("dismissing cancels the auto-accept", () => {
    propose();
    renderBanner();
    act(() => {
      screen.getByTestId("faster-route-dismiss").click();
    });
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(useNavigationStore.getState().route?.summary).toBe("via A46");
  });

  it("accepting immediately switches", () => {
    propose();
    renderBanner();
    act(() => {
      screen.getByTestId("faster-route-accept").click();
    });
    expect(useNavigationStore.getState().route?.summary).toBe("via A61");
  });
});
