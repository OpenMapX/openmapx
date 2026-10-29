import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../../../../../packages/i18n/locales/en.json";
import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("routes external brand images through the backend image proxy", () => {
    const markup = renderToStaticMarkup(
      <BrandMark
        branding={{
          name: "Entur Mobility",
          logoUrl: "https://api.entur.io/mobility/assets/operator.svg",
        }}
      />,
    );

    expect(markup).toContain(
      "http://localhost:3001/api/image-proxy?url=https%3A%2F%2Fapi.entur.io%2Fmobility%2Fassets%2Foperator.svg",
    );
    expect(markup).not.toContain('src="https://api.entur.io');
  });
});

it("credits a catalogue-derived initial without borrowing the hidden logo receipt", () => {
  const name = { sourceId: "name-suggestion-index", name: "Captured catalogue name" };
  const hidden = { sourceId: "hidden-logo", name: "Hidden logo selection" };
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BrandMark
        branding={{
          name: "Catalogue brand",
          logoUrl: "https://commons.wikimedia.org/wiki/Special:FilePath/Unknown.svg",
          contributors: [name, hidden],
          fieldContributors: { name: [name], logoUrl: [hidden] },
        }}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText("C")).toBeVisible();
  expect(screen.getByText("Captured catalogue name")).toBeVisible();
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.queryByText("Hidden logo selection")).toBeNull();
});
