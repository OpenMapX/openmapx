import type { Place } from "@openmapx/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => undefined }),
}));

const { PlaceInfoTab } = await import("./PlaceInfoTab");

const PLACE = {
  id: "p1",
  name: "The Museum",
  coordinates: [6.08, 50.77],
  primaryScheme: "osm",
  ids: {},
  osmTags: {
    amenity: "museum",
    name: "The Museum",
    "seamark:light:range": "8",
    "payment:cash": "yes",
    "payment:american_express": "yes",
    "payment:visa": "no",
    "payment:paypal": "yes",
    "payment:apple_pay": "yes",
    "diet:vegan": "yes",
    "internet_access:fee": "pay_per_use",
  },
} as unknown as Place;

describe("PlaceInfoTab visitor details", () => {
  it("keeps mapping metadata behind a complete raw-tag disclosure", async () => {
    const user = userEvent.setup();
    render(<PlaceInfoTab place={PLACE} isLoading={false} />);

    expect(screen.queryByText("seamark:light:range")).not.toBeInTheDocument();
    expect(screen.queryByText("The Museum")).not.toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: "allOpenStreetMapTags" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("seamark:light:range")).toBeVisible();
    expect(screen.getByText("8")).toBeVisible();
    expect(screen.getByText("payment:cash")).toBeVisible();
    expect(screen.getByText("The Museum")).toBeVisible();
  });

  it("credits the displayed extract and facts, adding a hidden raw tag only when expanded", async () => {
    const user = userEvent.setup();
    const short = { sourceId: "short", name: "Hidden short supplier" };
    const extract = { sourceId: "extract", name: "Extract supplier" };
    const raw = { sourceId: "raw", name: "Raw supplier" };
    const fact = { sourceId: "fact", name: "Fact supplier" };
    render(
      <PlaceInfoTab
        place={{
          ...PLACE,
          description: "Hidden short description",
          wikipediaExtract: "Displayed extract",
          facts: [{ label: "Founded", value: "1900", contributors: [fact] }],
          fieldContributors: {
            description: [short],
            wikipediaExtract: [extract],
            "osmTags.seamark:light:range": [raw],
          },
        }}
        isLoading={false}
      />,
    );
    expect(screen.getByText("Extract supplier")).toBeVisible();
    expect(screen.getByText("Fact supplier")).toBeVisible();
    expect(screen.queryByText("Hidden short supplier")).not.toBeInTheDocument();
    expect(screen.queryByText("Raw supplier")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "allOpenStreetMapTags" }));
    expect(screen.getByText("Raw supplier")).toBeVisible();
  });

  it("groups all payment tags with other visitor amenities and humanizes readable values", () => {
    render(<PlaceInfoTab place={PLACE} isLoading={false} />);

    expect(screen.getByText("paymentMethods")).toBeVisible();
    expect(screen.getByText("American Express")).toBeVisible();
    expect(screen.getByText("Cash")).toBeVisible();
    expect(screen.getByText("Visa")).toBeVisible();
    expect(screen.getByText("PayPal")).toBeVisible();
    expect(screen.getByText("Apple Pay")).toBeVisible();
    expect(screen.getByText(/Pay Per Use/)).toBeVisible();
    expect(screen.queryByText("Other details")).not.toBeInTheDocument();
  });
});
