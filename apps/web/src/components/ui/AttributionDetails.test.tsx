import {
  buildAttributionPresentation,
  projectAttributionPresentations,
} from "@openmapx/core/attribution";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import de from "../../../../../packages/i18n/locales/de.json";
import en from "../../../../../packages/i18n/locales/en.json";
import { AttributionDetails } from "./AttributionDetails";

function show(attribution: Attribution, locale: "en" | "de" = "en") {
  const group = projectAttributionPresentations([buildAttributionPresentation(attribution, "map")]);
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en}>
      <AttributionDetails entries={group.details} />
    </NextIntlClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: locale === "de" ? de.footer.attributions : "Credits" }),
  );
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

it.each([
  ["en", "Varies by item", "Licence not specified"],
  ["de", "Abhängig vom Eintrag", "Lizenz nicht angegeben"],
] as const)(
  "uses concise generic licence labels in %s while preserving required notices and links",
  (locale, perItem, unknown) => {
    const generic = "Determined by each contributing item or operator";
    const dialog = show(
      {
        sourceId: "mixed",
        name: "Contributing operators",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "imagery",
              subject: "Operator images",
              license: {
                kind: "per-item",
                raw: generic,
                url: "https://operator.example/licensing",
              },
              notice: "Credit the individual photographer",
              conditions: ["Check each image's permission"],
            },
            { scope: "data", subject: "Unknown dataset", license: { kind: "unknown" } },
          ],
        },
      },
      locale,
    );
    expect(dialog.getByRole("link", { name: perItem })).toHaveAttribute(
      "href",
      "https://operator.example/licensing",
    );
    expect(dialog.getByText(unknown)).toBeVisible();
    expect(dialog.queryByText(generic)).toBeNull();
    expect(dialog.getByText("Credit the individual photographer")).toBeVisible();
    expect(dialog.getByText("Check each image's permission")).toBeVisible();
  },
);

it("keeps distinct descriptors sharing a subject separate and preserves specific uncertain wording", () => {
  const specific = "Permission required from each copyright holder";
  const dialog = show({
    sourceId: "mixed",
    name: "Mixed content",
    licensing: {
      version: 1,
      bindings: [
        {
          scope: "data",
          subject: "Dataset",
          license: { kind: "per-item", raw: "Determined by each contributing item or operator" },
        },
        {
          scope: "data",
          subject: "Dataset",
          license: { kind: "unknown", raw: specific, url: "https://operator.example/permission" },
        },
        {
          scope: "imagery",
          subject: "Photo",
          license: { kind: "per-item", raw: "Per-file (CC BY-SA, CC BY, or Public Domain)" },
        },
        {
          scope: "data",
          subject: "Unspecified version",
          license: { kind: "unknown", raw: "CC BY-SA" },
        },
      ],
    },
  });
  expect(dialog.getByText("Varies by item")).toBeVisible();
  expect(dialog.getByRole("link", { name: specific })).toHaveAttribute(
    "href",
    "https://operator.example/permission",
  );
  expect(dialog.getByText("Per-file (CC BY-SA, CC BY, or Public Domain)")).toBeVisible();
  expect(dialog.getByText("CC BY-SA")).toBeVisible();
});

it("retains explicitly supplied credit and modification notes", () => {
  const dialog = show({
    sourceId: "dataset",
    name: "Dataset publisher",
    notes: "Adapted from the original dataset; names translated",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    },
  });
  expect(dialog.getByText("Adapted from the original dataset; names translated")).toBeVisible();
});
