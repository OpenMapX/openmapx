import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { OfflineNavigationBanner } from "./OfflineNavigationBanner";

function renderBanner(props: Partial<React.ComponentProps<typeof OfflineNavigationBanner>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <OfflineNavigationBanner
        connectivity="offline"
        rerouteUnavailable
        liveDataUnavailable
        coverage={{ kind: "not-downloaded", packageIds: [] }}
        onRetryReroute={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

describe("OfflineNavigationBanner", () => {
  it("explains route continuation, unavailable rerouting, live data, and missing map", () => {
    renderBanner();
    const banner = screen.getByTestId("offline-navigation-banner");
    expect(banner.textContent).toContain("Route continuation is available offline.");
    expect(banner.textContent).toContain("Rerouting is unavailable offline.");
    expect(banner.textContent).toContain("Live traffic");
    expect(banner.textContent).toContain("map for this location is not downloaded");
  });

  it("offers one deliberate retry only while online and off route", () => {
    const retry = vi.fn();
    renderBanner({
      connectivity: "online",
      coverage: { kind: "covered", packageId: "omp2-a" },
      offRoute: true,
      onRetryReroute: retry,
    });
    screen.getByTestId("offline-navigation-retry-reroute").click();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not show retry while the browser is offline", () => {
    renderBanner({ offRoute: true });
    expect(screen.queryByTestId("offline-navigation-retry-reroute")).toBeNull();
  });
});
