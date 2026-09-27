import type { PlacePhoto } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../../../../packages/i18n/locales/en.json";
import { PlacePhotoHero } from "./PlacePhotoHero";

const firstPhoto: PlacePhoto = {
  url: "https://example.com/first.jpg",
  source: "Example Photos",
  author: "A. Author",
  authorUrl: "https://example.com/author",
};
const secondPhoto: PlacePhoto = {
  url: "https://example.com/second.jpg",
  source: "Example Photos",
};

function renderHero(
  photos: PlacePhoto[],
  props?: { onClose?: () => void; onPhotoError?: (url: string) => void },
) {
  const onViewPhotos = vi.fn();
  const view = render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PlacePhotoHero
        photos={photos}
        placeName="Test Place"
        onViewPhotos={onViewPhotos}
        {...props}
      />
    </NextIntlClientProvider>,
  );
  return { ...view, onViewPhotos };
}

describe("PlacePhotoHero", () => {
  it("omits the hero without a usable first photo", () => {
    expect(renderHero([]).container.firstChild).toBeNull();
    expect(renderHero([{ ...firstPhoto, url: "javascript:bad" }]).container.firstChild).toBeNull();
  });

  it("opens the gallery from the keyboard without claiming every photo loads", async () => {
    const user = userEvent.setup();
    const { onViewPhotos } = renderHero([firstPhoto, secondPhoto]);

    const galleryButton = screen.getByRole("button", {
      name: "View photos of Test Place",
    });
    expect(galleryButton).toHaveTextContent("View photos");
    expect(galleryButton).not.toHaveTextContent(/\d/);
    galleryButton.focus();
    await user.keyboard("{Enter}");
    expect(onViewPhotos).toHaveBeenCalledTimes(1);
  });

  it("keeps the action when a later URL is unusable", () => {
    renderHero([firstPhoto, { ...secondPhoto, url: "javascript:bad" }]);
    expect(screen.getByRole("button", { name: "View photos of Test Place" })).toHaveTextContent(
      "View photos",
    );
  });

  it("keeps a one-photo gallery action and attribution link separate", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { onViewPhotos } = renderHero([firstPhoto], { onClose });

    const galleryButton = screen.getByRole("button", {
      name: "View photos of Test Place",
    });
    expect(galleryButton).toHaveTextContent("View photos");
    expect(galleryButton.querySelector("button, a")).toBeNull();

    await user.click(screen.getByRole("link", { name: "A. Author" }));
    expect(onViewPhotos).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onViewPhotos).not.toHaveBeenCalled();
    await user.click(galleryButton);
    expect(onViewPhotos).toHaveBeenCalledTimes(1);
  });

  it("reports a failed hero image so the parent can advance to another photo", () => {
    const onPhotoError = vi.fn();
    renderHero([firstPhoto, secondPhoto], { onPhotoError });

    fireEvent.error(screen.getByRole("img", { name: "Test Place" }));
    expect(onPhotoError).toHaveBeenCalledWith(firstPhoto.url);
  });
});
