import { type PlacePhoto, parseCommonsPage } from "@openmapx/core";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
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
  it("renders the metadata artist's ampersand as the exact visible credit", () => {
    const photo = parseCommonsPage({
      title: "File:Artist.jpg",
      imageinfo: [
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Artist.jpg",
          mime: "image/jpeg",
          extmetadata: {
            Artist: { value: "One &amp; Co" },
            LicenseShortName: { value: "CC BY 4.0" },
            LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
          },
        },
      ],
    });
    if (!photo) throw new Error("complete metadata should parse");
    const { container } = renderHero([photo]);
    expect(container.textContent).toContain("One & Co");
    expect(container.textContent).not.toContain("&amp;");
    expect(screen.getByRole("link", { name: "CC-BY-4.0" })).toHaveAttribute(
      "href",
      photo.licensing?.bindings[0].license.url,
    );
  });
  it("defers incomplete Commons bytes even when labeled as Wikipedia", () => {
    expect(
      renderHero([
        {
          url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg",
          source: "wikipedia",
        },
      ]).container.firstChild,
    ).toBeNull();
  });
  it("renders the captured file credit despite later catalogue changes", () => {
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Photo.jpg",
      source: "wikimedia-commons",
      author: "Captured artist",
      licensing: licensingFromDeclaration(
        "CC BY 4.0",
        "https://creativecommons.org/licenses/by/4.0/",
        "Data",
      ),
      pageUrl: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
      attributionText: "Mandatory notice",
      attributionLinks: [{ label: "Required credit link", url: "https://example.org/credit" }],
      contributors: [
        {
          sourceId: "wikimedia-commons",
          name: "Captured Commons",
          url: "https://commons.wikimedia.org/wiki/File:Photo.jpg",
        },
      ],
    };
    renderHero([photo]);
    expect(screen.getByText("Mandatory notice", { exact: false })).toBeVisible();
    expect(screen.getByRole("link", { name: "Captured Commons" })).toHaveAttribute(
      "href",
      photo.pageUrl,
    );
    expect(screen.getByRole("link", { name: "Required credit link" })).toHaveAttribute(
      "href",
      "https://example.org/credit",
    );
  });
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

it("renders decoded creator and permission query parameters in the file caption", () => {
  const photo = parseCommonsPage({
    title: "File:Links.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Links.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="https://creator.example/?id=7&amp;view=full">Creator</a>' },
          Permission: {
            value: '<a href="https://permission.example/?id=7&amp;view=full">permission record</a>',
          },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  if (!photo) throw new Error("complete file should parse");
  renderHero([photo]);
  expect(
    new URL(
      screen.getByRole("link", { name: "Creator" }).getAttribute("href") ?? "",
    ).searchParams.get("view"),
  ).toBe("full");
  expect(
    new URL(
      screen.getByRole("link", { name: "permission record" }).getAttribute("href") ?? "",
    ).searchParams.get("view"),
  ).toBe("full");
});

// The custom notice replaces the separate author display, so its creator link must survive.
it.each([false, true])("keeps one visible creator link with custom attribution=%s", (custom) => {
  const photo = parseCommonsPage({
    title: "File:CustomCreator.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/CustomCreator.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="https://creator.example/profile">Creator</a>' },
          ...(custom
            ? {
                Attribution: {
                  value:
                    'Required credit: <a href="https://creator.example/profile">Creator profile</a>',
                },
              }
            : {}),
          Permission: {
            value: 'Permission: <a href="https://permission.example/record">permission record</a>',
          },
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        },
      },
    ],
  });
  if (!photo) throw new Error("complete file should parse");
  const { container } = renderHero([photo]);
  expect(container.querySelectorAll('a[href="https://creator.example/profile"]')).toHaveLength(1);
  expect(screen.getByRole("link", { name: custom ? "Creator profile" : "Creator" })).toBeVisible();
  expect(screen.getByRole("link", { name: "permission record" })).toHaveAttribute(
    "href",
    "https://permission.example/record",
  );
  if (custom) expect(container.textContent).toContain("Required credit: Creator profile");
});
