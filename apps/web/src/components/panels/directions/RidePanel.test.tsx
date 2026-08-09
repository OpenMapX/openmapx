import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

const providers = {
  providers: [
    {
      id: "uber",
      name: "Uber",
      homepage: "https://www.uber.com/",
      capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
      permitsComparison: false,
      availability: { available: true, coverageChecked: false, products: [] },
      isDefault: true,
    },
    {
      id: "bolt",
      name: "Bolt",
      homepage: "https://bolt.eu/",
      capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
      permitsComparison: false,
      availability: { available: true, coverageChecked: false, products: [] },
      isDefault: false,
    },
  ],
  defaultProvider: "uber",
  comparison: { allowed: false, comparableProviderIds: [] },
};

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useRideProviders: () => ({ data: providers, isLoading: false }),
    useDirectionsStore: (selector: (s: unknown) => unknown) =>
      selector({ origin: [13.405, 52.52], destination: [13.377, 52.516] }),
  };
});

import { RidePanel } from "./RidePanel";

const renderPanel = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <RidePanel />
    </NextIntlClientProvider>,
  );

describe("RidePanel", () => {
  it("renders one chip per available provider", async () => {
    renderPanel();
    expect((await screen.findByText("Uber")).textContent).toBe("Uber");
    expect(screen.getByText("Bolt").textContent).toBe("Bolt");
  });

  it("renders exactly one open action, for the selected provider only", async () => {
    renderPanel();
    const actions = await screen.findAllByRole("button", { name: /open in/i });
    expect(actions).toHaveLength(1);
    expect(actions[0].textContent?.toLowerCase()).toContain("uber");
  });

  it("warns that a coordinate-less provider will not carry the trip", async () => {
    renderPanel();
    expect(await screen.findByText(/availability is not checked/i)).not.toBeNull();
  });
});
