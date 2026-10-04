import type { RideQuote } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { RideQuoteList } from "./RideQuoteList";

const quoted: RideQuote = {
  productId: "regular",
  product: { id: "regular", name: "Regular Ride" },
  pickupEtaSeconds: 240,
  fare: { amount: 18.75, currency: "CAD", basis: "quoted" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const estimated: RideQuote = {
  productId: "large",
  product: { id: "large", name: "Large Ride" },
  pickupEtaSeconds: 600,
  fare: { amount: 27.25, currency: "CAD", basis: "estimated" },
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const renderList = (props: Partial<Parameters<typeof RideQuoteList>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <RideQuoteList
        providerName="Example Taxi"
        quotes={[quoted, estimated]}
        expired={false}
        onBook={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe("RideQuoteList", () => {
  it.each([
    ["#FFFFFF", "rgba(0, 0, 0, 0.87)"],
    ["#042553", "rgb(255, 255, 255)"],
  ])("keeps product names readable on %s without a feed text colour", (color, expected) => {
    renderList({ quotes: [{ ...quoted, product: { ...quoted.product, color } }] });
    expect(getComputedStyle(screen.getByText("Regular Ride")).color).toBe(expected);
  });

  it("uses the feed's background and text colours for the product chip", () => {
    renderList({
      quotes: [
        { ...quoted, product: { ...quoted.product, color: "#042553", textColor: "#FFFFFF" } },
      ],
    });
    const chip = screen.getByText("Regular Ride");
    expect(getComputedStyle(chip).backgroundColor).toBe("rgb(4, 37, 83)");
    expect(getComputedStyle(chip).color).toBe("rgb(255, 255, 255)");
  });

  it("renders one row per quote with its fare", () => {
    renderList();
    expect(screen.getByText("Regular Ride").textContent).toBe("Regular Ride");
    expect(screen.getByText(/18\.75/).textContent).toContain("18.75");
    expect(screen.getByText("Large Ride").textContent).toBe("Large Ride");
    expect(screen.getByText(/27\.25/).textContent).toContain("27.25");
  });

  it("labels an estimated fare and leaves a quoted one unlabelled", () => {
    renderList();
    expect(screen.getAllByText(/estimated/i)).toHaveLength(1);
  });

  it("shows the expiry notice and disables booking when expired", () => {
    renderList({ quotes: [quoted], expired: true });
    expect(screen.getByText(/out of date/i)).not.toBeNull();
    expect((screen.getByRole("button", { name: /book/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("calls onBook with the quote's product id", async () => {
    const onBook = vi.fn();
    renderList({ quotes: [quoted], onBook });
    await userEvent.click(screen.getByRole("button", { name: /book/i }));
    expect(onBook).toHaveBeenCalledWith("regular");
  });

  it("tells the user when the provider returned no price", () => {
    renderList({ quotes: [] });
    expect(screen.getByText(/did not return a price/i)).not.toBeNull();
  });
});
