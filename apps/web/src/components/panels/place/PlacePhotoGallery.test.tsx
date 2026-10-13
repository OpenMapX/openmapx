import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../../../../packages/i18n/locales/en.json";
import { PlacePhotoGallery } from "./PlacePhotoGallery";

const photos = vi.hoisted(() => ({ items: [] as Array<Record<string, unknown>> }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  usePlacePhotos: () => ({ data: photos.items, isLoading: false }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
function open() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlacePhotoGallery open onClose={vi.fn()} placeName="Place" placeId="p1" lat={50} lng={8} />
    </NextIntlClientProvider>,
  );
}
function photo(name: string, license: string) {
  return {
    url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}.jpg`,
    source: "wikimedia-commons",
    author: `${name} artist`,
    licensing: licensingFromDeclaration(license),
    pageUrl: `https://commons.wikimedia.org/wiki/File:${name}.jpg`,
    contributors: [{ sourceId: "wikimedia-commons", name: "Captured Commons" }],
  };
}
describe("gallery file credits", () => {
  it("defers cached Commons images with incomplete file metadata", () => {
    photos.items = [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Unknown.jpg",
        source: "wikipedia",
      },
    ];
    open();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("credits every rendered thumbnail's own licence, including an unselected file", () => {
    photos.items = [photo("One", "CC BY 4.0"), photo("Two", "CC BY-SA 4.0")];
    open();
    expect(screen.getAllByRole("link", { name: "CC-BY-SA-4.0" }).length).toBeGreaterThan(0);
  });
});
