import { en } from "@openmapx/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

let providers = {
  providers: [
    {
      id: "uber",
      name: "Uber",
      homepage: "https://www.uber.com/",
      capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
      permitsComparison: false,
      availability: { available: true, coverageChecked: false, products: [] },
      handoffCarriesCoordinates: true,
      isDefault: true,
    },
    {
      id: "bolt",
      name: "Bolt",
      homepage: "https://bolt.eu/",
      capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
      permitsComparison: false,
      availability: { available: true, coverageChecked: false, products: [] },
      handoffCarriesCoordinates: false,
      isDefault: false,
    },
  ],
  defaultProvider: "uber",
  comparison: { allowed: false, comparableProviderIds: [] },
};

let quoteResults: unknown[] = [];

vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useRideProviders: () => ({ data: providers, isLoading: false }),
    useRideQuotes: () => ({
      results: quoteResults,
      isLoading: false,
      expiresAt:
        (quoteResults[0] as { quotes?: { expiresAt: string }[] })?.quotes?.[0]?.expiresAt ?? null,
      refetch: vi.fn(),
    }),
    useDirectionsStore: (selector: (s: unknown) => unknown) =>
      selector({ origin: [13.405, 52.52], destination: [13.377, 52.516] }),
  };
});

import { RidePanel } from "./RidePanel";

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <RidePanel />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
};

describe("RidePanel", () => {
  const baseProviders = providers;
  beforeEach(() => {
    quoteResults = [];
    providers = baseProviders;
  });

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

  it("says availability was not checked for a link-out provider", async () => {
    renderPanel();
    expect(await screen.findByText(/availability is not checked/i)).not.toBeNull();
  });

  it("keeps a stale price off screen when the expiry is unparseable", async () => {
    // `now >= Date.parse(x)` is false for NaN, which would leave the price up
    // forever; the canonical rule treats an unparseable expiry as expired.
    providers = {
      ...baseProviders,
      providers: [
        {
          ...baseProviders.providers[0],
          capabilities: { deepLink: true, quote: true, booking: false, tracking: false },
        },
        baseProviders.providers[1],
      ],
    };
    quoteResults = [
      {
        providerId: "uber",
        attributions: [],
        quotes: [{ productId: "x", product: { id: "x", name: "X" }, expiresAt: "not-a-date" }],
      },
    ];
    renderPanel();
    expect(await screen.findByText(/out of date/i)).not.toBeNull();
  });

  it("does not warn about coordinates for a provider whose link carries them", async () => {
    renderPanel();
    await screen.findByText("Uber");
    expect(screen.queryByText(/cannot carry your pickup/i)).toBeNull();
  });

  it("warns that a coordinate-less provider will not carry the trip", async () => {
    renderPanel();
    // Bolt publishes no parameterised link format, so selecting it must say so.
    await userEvent.click(await screen.findByText("Bolt"));
    expect(await screen.findByText(/cannot carry your pickup/i)).not.toBeNull();
  });
});
