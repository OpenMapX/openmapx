import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import en from "../../../../../packages/i18n/locales/en.json";
import { AttributionDetailsGroup } from "./AttributionDetailsGroup";
import { AttributionStrip } from "./AttributionStrip";

const source: Attribution = {
  sourceId: "agency",
  name: "Agency",
  url: "https://agency.example/",
  attributionText: "Required adjacent notice",
};
const secondary: Attribution = {
  ...source,
  attributionText: "Distinct notice",
  url: "https://agency.example/other",
};
const optional: Attribution = {
  sourceId: "optional",
  name: "Observations",
  licensing: {
    version: 1,
    bindings: [
      { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
    ],
  },
};
const intl = (children: React.ReactNode) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {children}
  </NextIntlClientProvider>
);

describe("grouped content credits", () => {
  it("shares one action while retaining adjacent notices, distinct receipts and image actions", () => {
    render(
      intl(
        <StrictMode>
          <AttributionDetailsGroup>
            <section aria-label="First">
              <AttributionStrip attributions={[source]} />
            </section>
            <section aria-label="Second">
              <AttributionStrip attributions={[source, secondary]} />
            </section>
            <section aria-label="Image">
              <AttributionStrip attributions={[optional]} surface="image" />
            </section>
          </AttributionDetailsGroup>
        </StrictMode>,
      ),
    );
    expect(
      within(screen.getByRole("region", { name: "First" })).getByText("Required adjacent notice"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Second" })).getByText("Required adjacent notice"),
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Image" })).getByRole("button", {
        name: "Credits",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Credits" })).toHaveLength(2);
    const action = screen.getAllByRole("button", { name: "Credits" }).at(-1);
    if (!action) throw new Error("Shared action missing");
    fireEvent.click(action);
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getAllByRole("listitem")).toHaveLength(2);
    expect(dialog.getByText("Required adjacent notice")).toBeTruthy();
    expect(dialog.getByText("Distinct notice")).toBeTruthy();
    expect(
      dialog.getAllByRole("link", { name: "Agency" }).map((link) => link.getAttribute("href")),
    ).toEqual(["https://agency.example/", "https://agency.example/other"]);
    expect(dialog.queryByText("Observations")).toBeNull();
  });

  it("replaces dynamic receipts and removes unmounted sections instead of accumulating stale credits", () => {
    const content = (first: Attribution[], second: boolean) =>
      intl(
        <AttributionDetailsGroup>
          <AttributionStrip attributions={first} provenanceDisplay="details" />
          {second && <AttributionStrip attributions={[secondary]} />}
        </AttributionDetailsGroup>,
      );
    const { rerender } = render(content([source], true));
    rerender(content([optional], false));
    expect(screen.getAllByRole("button", { name: "Credits" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getAllByRole("listitem")).toHaveLength(1);
    expect(dialog.getByText("Observations")).toBeTruthy();
    expect(dialog.queryByText("Agency")).toBeNull();
    expect(dialog.queryByText("Distinct notice")).toBeNull();
    rerender(content([], false));
    expect(screen.queryByRole("button", { name: "Credits" })).toBeNull();
  });

  it("preserves standalone actions outside a group", () => {
    render(intl(<AttributionStrip attributions={[source]} />));
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getByText("Required adjacent notice")).toBeTruthy();
  });
});
