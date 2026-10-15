import {
  buildAttributionPresentation,
  projectAttributionPresentations,
} from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../../../../packages/i18n/locales/en.json";
import { AttributionDetails } from "./AttributionDetails";

function show(attribution: Attribution) {
  const group = projectAttributionPresentations([buildAttributionPresentation(attribution, "map")]);
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AttributionDetails entries={group.details} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Credits" }));
  return within(screen.getByRole("dialog"));
}

describe("structured credit details", () => {
  it("separates a readable source heading and data licence from software terms", () => {
    const dialog = show({
      sourceId: "omt",
      name: "© OpenMapTiles",
      url: "https://openmaptiles.org/",
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "style",
            subject: "OpenMapTiles schema and map design",
            license: { kind: "spdx", expression: "CC-BY-4.0" },
          },
          {
            scope: "software",
            subject: "OpenMapTiles code",
            license: { kind: "spdx", expression: "BSD-3-Clause" },
          },
        ],
      },
    });
    expect(dialog.getByRole("heading", { name: "© OpenMapTiles" })).toBeTruthy();
    expect(dialog.getByRole("link", { name: "CC-BY-4.0" })).toBeTruthy();
    expect(dialog.getByText("OpenMapTiles code")).toBeTruthy();
    expect(dialog.queryByText("Software and service terms")).toBeNull();
    expect(dialog.queryByText(/OpenMapTiles \(OpenMapTiles schema/)).toBeNull();
    expect(dialog.getByRole("link", { name: "BSD-3-Clause" })).toHaveAttribute(
      "href",
      "https://opensource.org/licenses/BSD-3-Clause",
    );
  });

  it("keeps distinct supplied notices, grant conditions and source links without printing policy reasons", () => {
    const dialog = show({
      sourceId: "weather",
      name: "Weather service",
      url: "https://weather.example/",
      attributionText: 'Required <a href="https://publisher.example/">publisher notice</a>',
      publisher: { name: "Actual publisher", url: "https://agency.example/" },
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "data",
            subject: "Observations",
            license: { kind: "spdx", expression: "CC-BY-4.0" },
            notice: "Measurements modified",
            conditions: ["Preserve observation time"],
            attribution: {
              placement: "details",
              surfaces: ["map"],
              basis: "licence",
              reviewedAt: "2026-10-15",
              evidenceUrls: ["https://policy.example/"],
              reason: "Internal placement explanation",
            },
          },
          {
            scope: "service",
            subject: "Acquisition passed-through policy",
            license: {
              kind: "custom",
              namespace: "test",
              id: "LicenseRef-Service",
              name: "Acquisition passed-through policy terms",
              url: "https://service.example/terms",
            },
          },
        ],
      },
    });
    expect(dialog.getByRole("link", { name: "publisher notice" })).toHaveAttribute(
      "href",
      "https://publisher.example/",
    );
    expect(dialog.getByRole("link", { name: "Actual publisher" })).toBeTruthy();
    expect(dialog.getByText("Measurements modified")).toBeTruthy();
    expect(dialog.getByText("Preserve observation time")).toBeTruthy();
    expect(dialog.getByRole("link", { name: "Terms of use" })).toHaveAttribute(
      "href",
      "https://service.example/terms",
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("Internal placement explanation");
  });
});

it("retains same-named credit and publisher links when their destinations differ", () => {
  const dialog = show({
    sourceId: "provider",
    name: "Provider",
    url: "https://provider.example/",
    attributionText: '<a href="https://provider.example/required">Provider</a>',
    publisher: { name: "Provider", url: "https://publisher.example/credit" },
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    },
  });
  const destinations = dialog
    .getAllByRole("link", { name: "Provider" })
    .map((link) => link.getAttribute("href"));
  for (const url of [
    "https://provider.example/",
    "https://provider.example/required",
    "https://publisher.example/credit",
  ])
    expect(destinations).toContain(url);
});

it("uses the supplied linked source credit as the heading without repeating its generated source name", () => {
  const dialog = show({
    sourceId: "weather",
    name: "Weather gateway (agency observations)",
    url: "https://gateway.example/",
    attributionText:
      '<a href="https://agency.example/">Agency</a> via <a href="https://gateway.example/">Gateway</a>',
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    },
  });
  const heading = within(dialog.getByRole("heading", { name: "Agency via Gateway" }));
  expect(heading.getByRole("link", { name: "Agency" })).toHaveAttribute(
    "href",
    "https://agency.example/",
  );
  expect(heading.getByRole("link", { name: "Gateway" })).toHaveAttribute(
    "href",
    "https://gateway.example/",
  );
  expect(dialog.queryByText("Weather gateway (agency observations)")).toBeNull();
  expect(dialog.getByRole("link", { name: "CC-BY-4.0" })).toBeTruthy();
});
