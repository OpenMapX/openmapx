import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../../../../packages/i18n/locales/en.json";
import { PlacePhotoGallery } from "./PlacePhotoGallery";

const photos = vi.hoisted(() => ({ items: [] as Array<Record<string, unknown>> }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  usePlacePhotos: () => ({ data: photos.items, isLoading: false }),
}));
vi.mock("@/integration-api/components/LocationMinimap", () => ({
  LocationMinimap: ({
    onCreditsChange,
  }: {
    onCreditsChange?: (credits: Array<{ sourceId: string; name: string }>) => void;
  }) => {
    return (
      <button
        type="button"
        data-testid="capture-minimap"
        onClick={() =>
          onCreditsChange?.([{ sourceId: "supplier", name: "Installed map supplier" }])
        }
      >
        Load map
      </button>
    );
  },
}));
vi.mock("@/components/map/MapCredits", () => ({
  MapCredits: ({ attributions }: { attributions: Array<{ name: string }> }) => (
    <span data-testid="gallery-map-credits">{attributions.map((a) => a.name).join(" | ")}</span>
  ),
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
function open(onClose = vi.fn()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlacePhotoGallery open onClose={onClose} placeName="Place" placeId="p1" lat={50} lng={8} />
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

it("keeps capture-map credits in gallery information, outside the photo stage and minimap", () => {
  photos.items = [{ ...photo("Located", "CC BY 4.0"), coordinates: [8, 50] }];
  open();
  fireEvent.click(screen.getByTestId("capture-minimap"));
  const credits = screen.getByTestId("gallery-map-credits");
  expect(credits).toHaveTextContent("Installed map supplier");
  expect(
    within(screen.getByTestId("gallery-photo-stage")).queryByTestId("gallery-map-credits"),
  ).toBeNull();
  expect(screen.getByTestId("gallery-information").contains(credits)).toBe(true);
});

it("keeps each thumbnail credit in the same image cell, with its required notice intact", () => {
  const notice = "A mandatory custom credit that wraps over several lines on a narrow thumbnail";
  photos.items = [
    { ...photo("LongNotice", "CC BY 4.0"), attributionOverride: notice },
    photo("Two", "CC BY-SA 4.0"),
  ];
  open();
  const creditedThumbnails = screen
    .getAllByTestId("gallery-thumbnail")
    .filter((thumbnail) => thumbnail.textContent?.includes(notice));
  expect(creditedThumbnails).toHaveLength(2);
  for (const thumbnail of creditedThumbnails) {
    const imageCell = within(thumbnail).getByTestId("thumbnail-image-cell");
    expect(imageCell.querySelector("img")).not.toBeNull();
    expect(within(imageCell).getByText(notice)).toBeVisible();
  }
});

it("closes photo details with Escape while keeping the gallery open and returning focus", async () => {
  const user = userEvent.setup();
  photos.items = [photo("One", "CC BY 4.0")];
  const onClose = vi.fn();
  open(onClose);
  const trigger = within(screen.getByTestId("gallery-information")).getByRole("button", {
    name: "Photo credits",
  });
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Photo credits" })).toBeVisible();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Photo credits" })).toBeNull());
  expect(onClose).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});
