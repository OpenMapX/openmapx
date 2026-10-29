import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AttributionDetailsGroup } from "@/components/ui/AttributionDetailsGroup";
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

it("keeps row content with a credited initial when the catalogue logo cannot be displayed", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BrandMark
        branding={{
          name: "Shell",
          contributors: [{ sourceId: "nsi", name: "Name Suggestion Index" }],
        }}
      >
        <h3>Shell station</h3>
      </BrandMark>
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole("heading", { name: "Shell station" })).toBeVisible();
  expect(screen.getByText("S")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /credits/i }));
  expect(
    within(screen.getByRole("dialog")).getAllByText("Name Suggestion Index").length,
  ).toBeGreaterThan(0);
});

it("shares catalogue details across fuel rows and retains only displayed fields after image failure", () => {
  const name = { sourceId: "nsi", name: "Captured catalogue" };
  const image = { sourceId: "logo", name: "Logo-only supplier" };
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AttributionDetailsGroup placement="footer">
        {["Shell", "Aral"].map((brand) => (
          <BrandMark
            key={brand}
            branding={{
              name: brand,
              logoUrl: "https://example.com/brand.png",
              fieldContributors: { name: [name], logoUrl: [image] },
            }}
          >
            <h3>{brand}</h3>
          </BrandMark>
        ))}
      </AttributionDetailsGroup>
    </NextIntlClientProvider>,
  );
  expect(screen.getAllByRole("button", { name: /credits/i })).toHaveLength(1);
  for (const img of screen.getAllByRole("img")) fireEvent.error(img);
  expect(screen.getByRole("heading", { name: "Shell" })).toBeVisible();
  expect(screen.getByText("S")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /credits/i }));
  expect(
    within(screen.getByRole("dialog")).getAllByText("Captured catalogue").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText("Logo-only supplier")).toBeNull();
});

it("lets interactive rows keep required credit links outside the station button", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BrandMark
        branding={{
          name: "Shell",
          contributors: [
            { sourceId: "supplier", name: "Required supplier", url: "https://supplier.test" },
          ],
        }}
        renderRow={({ content, credits }) => (
          <>
            <button type="button">{content}</button>
            {credits}
          </>
        )}
      >
        <h3>Shell</h3>
      </BrandMark>
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole("heading", { name: "Shell" }).closest("button")).not.toBeNull();
  expect(screen.getByRole("link", { name: "Required supplier" }).closest("button")).toBeNull();
});
