import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { expect, it } from "vitest";
import { HotelPriceBadge } from "./HotelPriceBadge";

it("shows captured rate credit and opens its complete shared details beside the price", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <HotelPriceBadge
        offer={{
          source: "liteapi",
          total: 150,
          nightlyFrom: 75,
          currency: "EUR",
          refundable: true,
          contributors: [
            {
              sourceId: "liteapi",
              name: "Captured rate supplier",
              url: "https://rates.example/",
              attributionText: "Acquired rate notice",
            },
          ],
        }}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText(/75/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Acquired rate notice/ })).toHaveAttribute(
    "href",
    "https://rates.example/",
  );
  await userEvent.click(screen.getByRole("button", { name: "Credits" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Captured rate supplier");
  expect(screen.getByRole("dialog")).toHaveTextContent("Acquired rate notice");
});
