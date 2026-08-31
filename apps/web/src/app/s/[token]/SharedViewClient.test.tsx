import { en } from "@openmapx/i18n";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/share/SharedMapView", () => ({
  SharedMapView: () => <div data-testid="shared-map" />,
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ getByDomain: () => [] }),
}));
vi.mock("@openmapx/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...original,
    useDirections: () => ({ data: undefined, isError: false }),
  };
});

const { SharedViewClient } = await import("./SharedViewClient");

function renderShare(share: Parameters<typeof SharedViewClient>[0]["share"]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SharedViewClient share={share} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("SharedViewClient", () => {
  it("renders a list share with resolved built-in name, places, and notes", () => {
    renderShare({
      type: "list",
      mode: "snapshot",
      name: "$favorites",
      icon: null,
      places: [
        { name: "Cafe", lat: 52.5, lng: 13.4, address: "Street 1", note: "good", placeId: null },
      ],
    });
    expect(screen.getByText("Favorites")).toBeInTheDocument();
    expect(screen.getByText("Cafe")).toBeInTheDocument();
    expect(screen.getByText("good")).toBeInTheDocument();
    expect(screen.getByTestId("shared-map")).toBeInTheDocument();
  });

  it("renders a route share's waypoints and open-in-app action", () => {
    renderShare({
      type: "route",
      mode: "snapshot",
      route: {
        waypoints: [
          { lat: 52.52, lng: 13.405, label: "Berlin" },
          { lat: 53.55, lng: 9.99, label: "Hamburg" },
        ],
        mode: "driving",
      },
    });
    expect(screen.getByText("Berlin")).toBeInTheDocument();
    expect(screen.getByText("Hamburg")).toBeInTheDocument();
    expect(screen.getByText("Open route in OpenMapX")).toBeInTheDocument();
  });

  it("renders the unavailable state for a null share", () => {
    renderShare(null);
    expect(
      screen.getByText("This link is temporarily unavailable. Please try again in a moment."),
    ).toBeInTheDocument();
  });
});
