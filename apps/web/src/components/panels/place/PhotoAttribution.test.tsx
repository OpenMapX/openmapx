import { parseCommonsPage, withPhotoContributors } from "@openmapx/core";
import type { Licensing } from "@openmapx/mobility-core/licensing";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../../../../../packages/i18n/locales/en.json";
import { PhotoAttribution } from "./PhotoAttribution";

function commons(license = "Public domain", extra = {}) {
  const photo = parseCommonsPage({
    title: "File:Cathedral.jpg",
    imageinfo: [
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Cathedral.jpg",
        mime: "image/jpeg",
        extmetadata: {
          Artist: { value: '<a href="https://creator.example/profile">David Scull</a>' },
          LicenseShortName: { value: license },
          Credit: {
            value:
              '<a href="https://archive.example/original">https://archive.example/original</a>; full-sized version obtained on request',
          },
          UsageTerms: { value: license },
          ...extra,
        },
      },
    ],
  });
  if (!photo) throw new Error("Complete Commons fixture must parse");
  return photo;
}

function caption(photo = commons()) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PhotoAttribution photo={photo} />
    </NextIntlClientProvider>,
  );
}

describe("photo credit presentation", () => {
  it("keeps creator and licence adjacent, with acquisition prose and exact source links one action away", () => {
    const photo = commons();
    const before = structuredClone(photo);
    const { container } = caption(photo);
    expect(screen.getByRole("link", { name: "David Scull" })).toHaveAttribute(
      "href",
      "https://creator.example/profile",
    );
    expect(container.textContent).toContain("Public domain");
    expect(container.textContent).not.toContain("https://archive.example");
    expect(container.textContent).not.toContain("obtained on request");
    fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toContain("full-sized version obtained on request");
    expect(dialog.textContent).not.toContain("https://archive.example/original");
    expect(dialog.textContent?.match(/Public domain/g)).toHaveLength(1);
    expect(dialog.querySelector('a[href="https://archive.example/original"]')).not.toBeNull();
    expect(dialog.querySelector('a[href*="File:Cathedral.jpg"]')).not.toBeNull();
    expect(photo).toEqual(before);
  });

  it("uses equally prominent linked creator/licence captions for earlier CC photos without repeating metadata", () => {
    const { container } = caption(
      commons("CC BY-SA 3.0", {
        LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/3.0/" },
        Credit: { value: "Own work" },
        UsageTerms: { value: "Creative Commons Attribution-Share Alike 3.0" },
      }),
    );
    expect(screen.getByRole("link", { name: "CC-BY-SA-3.0" })).toHaveAttribute(
      "href",
      "https://creativecommons.org/licenses/by-sa/3.0/",
    );
    expect(container.textContent).not.toContain("Own work");
    fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
    expect(screen.getByRole("dialog").textContent).not.toContain("Own work");
  });

  it("retains custom attribution wording and creator links beside the image", () => {
    const { container } = caption(
      commons("CC BY 4.0", {
        Attribution: {
          value: 'Credit: <a href="https://creator.example/custom">Museum collection</a>',
        },
      }),
    );
    expect(container.textContent).toContain("Credit: Museum collection");
    expect(screen.getByRole("link", { name: "Museum collection" })).toHaveAttribute(
      "href",
      "https://creator.example/custom",
    );
  });

  it("does not hide unreviewed file requirements behind the compact caption", () => {
    const { container } = caption(
      commons("Special photo agreement", {
        LicenseUrl: { value: "https://photos.example/terms" },
        Permission: { value: "Always show the exact supplied notice" },
      }),
    );
    expect(container.textContent).toContain("Always show the exact supplied notice");
  });

  it.each(["photo", "receipt"] as const)(
    "preserves stricter %s policy when the other file declaration has no policy",
    (owner) => {
      const photo = commons("CC BY 4.0");
      if (!photo.contributors?.[0]) throw new Error("Captured fixture receipt missing");
      const strict: Licensing = {
        version: 1,
        bindings: [
          {
            scope: "imagery",
            subject: "File",
            license: { kind: "spdx", expression: "CC-BY-4.0" },
            attribution: {
              placement: "visible",
              surfaces: ["image"],
              basis: "provider-terms",
              reviewedAt: "2026-10-15",
              reason: "Required on the actual image",
              evidenceUrls: ["https://photos.example/terms"],
              compactText: "Exact required image notice",
              logo: "mapillary",
              prominence: "normal",
            },
          },
        ],
      };
      if (owner === "photo") photo.licensing = structuredClone(strict);
      else photo.contributors[0].licensing = structuredClone(strict);
      const { container } = caption(photo);
      expect(container.textContent).toContain("Exact required image notice");
      expect(screen.getByRole("img", { name: "Mapillary" })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
      expect(screen.getByRole("dialog").querySelector('img[alt="Mapillary"]')).not.toBeNull();
    },
  );

  it("retains an exact captured source URL alongside a different file-page URL", () => {
    const photo = commons("CC BY 4.0");
    if (!photo.contributors?.[0]) throw new Error("Captured fixture receipt missing");
    photo.contributors[0].url = "https://archive.example/exact-source";
    const before = structuredClone(photo);
    caption(photo);
    fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector('a[href="https://archive.example/exact-source"]')).not.toBeNull();
    expect(dialog.querySelector('a[href*="File:Cathedral.jpg"]')).not.toBeNull();
    expect(photo).toEqual(before);
  });
});

it("retains a distinct captured publisher when simplifying generated photo credit", () => {
  const photo = commons();
  if (!photo.contributors?.[0]) throw new Error("Missing photo receipt");
  photo.contributors[0].publisher = { name: "Original archive" };
  caption(photo);
  fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
  expect(screen.getByRole("dialog").textContent).toContain("Original archive");
});

it("keeps explicitly required Commons source credit even with a public-domain declaration", () => {
  caption(
    commons("Public domain", {
      AttributionRequired: { value: "true" },
      Credit: { value: "Required original archive credit" },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /photo credits/i }));
  expect(screen.getByRole("dialog").textContent).toContain("Required original archive credit");
});

it("uses a complete strict photo notice once instead of appending it to a duplicate caption", () => {
  const photo = withPhotoContributors(
    {
      url: "https://images.example/photo.jpg",
      pageUrl: "https://flickr.example/photo",
      source: "flickr",
      author: "Ada",
      authorUrl: "https://flickr.example/ada",
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "imagery",
            subject: "Photo",
            license: { kind: "spdx", expression: "CC-BY-ND-2.0" },
          },
        ],
      },
    },
    "Flickr",
  );
  const before = structuredClone(photo);
  const { container } = caption(photo);
  expect(container.textContent?.match(/Ada/g)).toHaveLength(1);
  expect(container.textContent?.match(/Flickr/g)).toHaveLength(1);
  expect(container.textContent?.match(/CC-BY-ND-2.0/g)).toHaveLength(1);
  expect(screen.getByRole("link", { name: "Ada" })).toHaveAttribute(
    "href",
    "https://flickr.example/ada",
  );
  expect(photo).toEqual(before);
});

it("separates distinct mandatory image notices from a readable caption", () => {
  const photo = commons("CC BY 4.0");
  if (!photo.contributors) throw new Error("Missing photo receipt");
  photo.contributors = [
    ...photo.contributors,
    {
      sourceId: "service",
      name: "Camera service",
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
              reviewedAt: "2026-10-16",
              evidenceUrls: ["https://service.example/terms"],
              reason: "Required notice",
              compactText: "Exact camera notice",
            },
          },
        ],
      },
    },
  ];
  const { container } = caption(photo);
  expect(container.textContent).toContain("CC-BY-4.0");
  expect(container.textContent).toMatch(/CC-BY-4.0.*[·|].*Exact camera notice/);
});
