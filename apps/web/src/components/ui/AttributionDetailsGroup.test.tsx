import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import en from "../../../../../packages/i18n/locales/en.json";
import { AttributionDetailsGroup } from "./AttributionDetailsGroup";
import { AttributionStrip } from "./AttributionStrip";
import { SectionAttribution } from "./SectionAttribution";

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

  it("can consolidate complete panel credits at the bottom without moving image credits", () => {
    render(
      intl(
        <StrictMode>
          <AttributionDetailsGroup placement="footer">
            <section aria-label="Header">
              <AttributionStrip attributions={[source]} />
            </section>
            <section aria-label="Overview">
              <SectionAttribution attributions={[source, secondary, optional]} inset />
            </section>
            <section aria-label="Image">
              <AttributionStrip attributions={[optional]} surface="image" />
            </section>
            <p>End of panel content</p>
          </AttributionDetailsGroup>
        </StrictMode>,
      ),
    );
    expect(screen.getByRole("region", { name: "Header" }).textContent).toBe("");
    expect(screen.getByRole("region", { name: "Overview" }).childElementCount).toBe(0);
    const footers = screen.getAllByRole("contentinfo");
    const footer = footers.at(-1);
    if (!footer) throw new Error("Panel footer missing");
    expect(within(footer).getAllByText("Required adjacent notice")).toHaveLength(1);
    expect(within(footer).getByText("Distinct notice")).toBeTruthy();
    expect(
      screen.getByText("End of panel content").compareDocumentPosition(footer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Image" })).getByRole("button", {
        name: "Credits",
      }),
    ).toBeTruthy();
    fireEvent.click(within(footer).getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem")).toHaveLength(3);
  });

  it("updates the consolidated footer when mounted panel content changes", () => {
    const content = (receipts: Attribution[], extra: boolean) =>
      intl(
        <AttributionDetailsGroup placement="footer">
          <AttributionStrip attributions={receipts} />
          {extra && <AttributionStrip attributions={[secondary]} />}
        </AttributionDetailsGroup>,
      );
    const { rerender } = render(content([source], true));
    rerender(content([optional], false));
    expect(screen.queryByText("Required adjacent notice")).toBeNull();
    expect(screen.queryByText("Distinct notice")).toBeNull();
    expect(screen.getAllByRole("contentinfo")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getByText("Observations")).toBeTruthy();
    rerender(content([], false));
    expect(screen.queryByRole("contentinfo")).toBeNull();
  });

  it("deduplicates visible notices without losing separately captured detail entries", () => {
    render(
      intl(
        <AttributionDetailsGroup placement="footer">
          <AttributionStrip attributions={[{ ...source, retrievedAt: "2026-10-16T10:00:00Z" }]} />
          <AttributionStrip attributions={[{ ...source, retrievedAt: "2026-10-16T11:00:00Z" }]} />
        </AttributionDetailsGroup>,
      ),
    );
    expect(screen.getAllByText("Required adjacent notice")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("keeps widget-required notices adjacent and shares their details without repeating the notice below", () => {
    render(
      intl(
        <AttributionDetailsGroup placement="footer">
          <section aria-label="Weather">
            <AttributionStrip attributions={[source]} keepVisibleWithContent />
          </section>
          <section aria-label="Ordinary section">
            <AttributionStrip attributions={[optional]} />
          </section>
        </AttributionDetailsGroup>,
      ),
    );
    expect(
      within(screen.getByRole("region", { name: "Weather" })).getByText("Required adjacent notice"),
    ).toBeTruthy();
    expect(screen.getAllByText("Required adjacent notice")).toHaveLength(1);
    const footer = screen.getAllByRole("contentinfo").at(-1);
    if (!footer) throw new Error("Panel footer missing");
    expect(within(footer).queryByText("Required adjacent notice")).toBeNull();
    fireEvent.click(within(footer).getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getByText("Required adjacent notice")).toBeTruthy();
  });

  it("keeps the footer action and required branding when every notice must remain adjacent", () => {
    const branded: Attribution = {
      sourceId: "weather",
      name: "OpenWeather",
      attributionText: "Required adjacent notice",
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "service",
            subject: "API",
            license: { kind: "unknown" },
            attribution: {
              placement: "visible",
              surfaces: ["content"],
              basis: "provider-terms",
              reviewedAt: "2026-10-16",
              evidenceUrls: ["https://openweathermap.org/"],
              reason: "Required branding beside readings",
              compactText: "Required adjacent notice",
              logo: "openweather",
            },
          },
        ],
      },
    };
    render(
      intl(
        <AttributionDetailsGroup placement="footer">
          <AttributionStrip attributions={[branded]} keepVisibleWithContent />
        </AttributionDetailsGroup>,
      ),
    );
    expect(screen.getAllByText("Required adjacent notice")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getByText("Required adjacent notice")).toBeTruthy();
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: "OpenWeather" }),
    ).toBeTruthy();
  });

  it("preserves standalone actions outside a group", () => {
    render(intl(<AttributionStrip attributions={[source]} />));
    fireEvent.click(screen.getByRole("button", { name: "Credits" }));
    expect(within(screen.getByRole("dialog")).getByText("Required adjacent notice")).toBeTruthy();
  });
});
