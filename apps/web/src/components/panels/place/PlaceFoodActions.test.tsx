import type { DeliveryProviderInfo, Place } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaceFoodActions } from "./PlaceFoodActions";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const providers: DeliveryProviderInfo[] = [
  {
    id: "ubereats",
    name: "Uber Eats",
    domain: "ubereats.com",
    homepage: "https://ubereats.com",
    color: "#000",
    linkKind: "search",
  },
  {
    id: "wolt",
    name: "Wolt",
    domain: "wolt.com",
    homepage: "https://wolt.com",
    color: "#000",
    linkKind: "search",
  },
  {
    id: "lieferando",
    name: "Lieferando",
    domain: "lieferando.de",
    homepage: "https://lieferando.de",
    color: "#000",
    linkKind: "browse",
  },
];

const hookState: {
  catalog: DeliveryProviderInfo[];
  resolved?: DeliveryProviderInfo[];
  links?: { menuUrl?: string; orderUrl?: string; providerOrderUrls?: string[] };
  restaurantLinksEnabled?: boolean;
} = { catalog: providers };

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useCountryFromCoordinates: () => ({ data: "de" }),
    useDeliveryProviderCatalog: () => ({ data: { providers: hookState.catalog } }),
    useDeliveryProviders: () => ({
      data: hookState.resolved ? { providers: hookState.resolved } : undefined,
    }),
    useRestaurantLinks: (_website: string | null | undefined, enabled: boolean) => {
      hookState.restaurantLinksEnabled = enabled;
      return { data: hookState.links };
    },
  };
});

function place(osmTags: Record<string, string> = {}): Place {
  return {
    id: "osm:node:1",
    ids: { osm: "node:1" },
    primaryScheme: "osm",
    name: "Test Restaurant",
    address: "Pontstraße 1, Aachen",
    city: "Aachen",
    countryCode: "de",
    coordinates: [6.08, 50.77],
    category: "restaurant",
    osmTags,
  };
}

describe("PlaceFoodActions delivery semantics", () => {
  beforeEach(() => {
    hookState.catalog = providers;
    hookState.resolved = undefined;
    hookState.links = undefined;
    hookState.restaurantLinksEnabled = undefined;
    vi.stubGlobal("open", vi.fn());
  });

  it("labels search and city browsing honestly", () => {
    render(<PlaceFoodActions place={place()} />);
    fireEvent.click(screen.getByText("place.orderDelivery"));
    expect(screen.getAllByText("place.deliverySearch")).toHaveLength(2);
    expect(screen.getByText("place.deliveryBrowse")).toBeDefined();
  });

  it("suppresses unconfirmed providers when OSM says delivery=no", () => {
    render(<PlaceFoodActions place={place({ delivery: "no" })} />);
    expect(screen.queryByText("place.orderDelivery")).toBeNull();
  });

  it("promotes and opens an exact OSM provider URL", () => {
    const exact = "https://wolt.com/en/deu/aachen/restaurant/test";
    render(<PlaceFoodActions place={place({ "delivery:website": exact })} />);
    fireEvent.click(screen.getByText("place.orderDelivery"));
    fireEvent.keyDown(
      screen.getByText("place.deliveryExact").closest('[role="button"]') as Element,
      {
        key: "Enter",
      },
    );
    expect(window.open).toHaveBeenCalledWith(exact, "_blank", "noopener,noreferrer");
  });

  it("shows a first-party order handoff before marketplace choices", () => {
    hookState.links = { orderUrl: "https://order.example.com/aachen" };
    render(<PlaceFoodActions place={{ ...place(), website: "https://example.com" }} />);
    fireEvent.click(screen.getByText("place.orderDirect"));
    expect(window.open).toHaveBeenCalledWith(
      "https://order.example.com/aachen",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("prefers an explicit OSM order URL over crawled discovery", () => {
    hookState.links = { orderUrl: "https://example.com/weaker-order" };
    render(
      <PlaceFoodActions
        place={{
          ...place({ "website:orders": "https://example.com/osm-order" }),
          website: "https://example.com",
        }}
      />,
    );
    fireEvent.click(screen.getByText("place.orderDirect"));
    expect(window.open).toHaveBeenCalledWith(
      "https://example.com/osm-order",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("promotes an exact provider link exposed by the official homepage", () => {
    hookState.links = {
      providerOrderUrls: ["https://wolt.com/en/deu/aachen/restaurant/from-official-site"],
    };
    render(<PlaceFoodActions place={{ ...place(), website: "https://example.com" }} />);
    fireEvent.click(screen.getByText("place.orderDelivery"));
    expect(screen.getByText("place.deliveryExact")).toBeDefined();
    expect(screen.getByText(/place.deliveryConfirmed/)).toBeDefined();
  });

  it("does not send provider storefronts to restaurant website discovery", () => {
    render(
      <PlaceFoodActions
        place={{
          ...place(),
          website: "https://wolt.com/en/deu/aachen/restaurant/test",
        }}
      />,
    );
    expect(hookState.restaurantLinksEnabled).toBe(false);
  });

  it("describes partner-tag evidence without claiming an exact match", () => {
    render(<PlaceFoodActions place={place({ "delivery:partner": "Wolt" })} />);
    fireEvent.click(screen.getByText("place.orderDelivery"));
    expect(screen.getByText(/place.deliveryPartner/)).toBeDefined();
  });
});
