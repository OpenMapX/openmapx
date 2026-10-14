import type { StreetLevelCapabilities, StreetLevelImage } from "@openmapx/core";
import { expect, it, vi } from "vitest";
import { render, screen } from "@/test";
import { StreetLevelInfoCard } from "./StreetLevelInfoCard";

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useReverseGeocoding: () => ({ data: undefined }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => (key: string) => key,
}));
it("retains image source and branding when optional capture time and reverse geocoding are unavailable", () => {
  const image: StreetLevelImage = {
    id: "one",
    providerId: "mapillary",
    lngLat: [6, 51],
    isPano: false,
    assets: { sd: "https://image.test/frame" },
    author: "Actual Photographer",
    contributors: [
      {
        sourceId: "mapillary",
        name: "Mapillary",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "service",
              subject: "API",
              license: { kind: "unknown" },
              attribution: {
                placement: "visible",
                surfaces: ["image"],
                basis: "provider-terms",
                reviewedAt: "2026-10-14",
                evidenceUrls: ["https://www.mapillary.com/terms"],
                reason: "Linked logo",
                logo: "mapillary",
                compactText: '<a href="https://www.mapillary.com/">Mapillary</a>',
              },
            },
          ],
        },
      },
    ],
  };
  render(
    <StreetLevelInfoCard
      image={image}
      provider={{ id: "mapillary", name: "Mapillary", color: "#05cb63" } as StreetLevelCapabilities}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("img", { name: "Mapillary" })).toHaveAttribute(
    "src",
    "/mapillary-logo.svg",
  );
  expect(screen.getByText("Actual Photographer")).toBeVisible();
});
