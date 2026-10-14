import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useTranslations: () => (key: string) => key,
}));

import en from "../../../../../../packages/i18n/locales/en.json";
import { BrandLogo } from "../BrandLogo";

const logo = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useBrandLogoAttribution: () => logo,
}));
const credited = {
  logoFile: "Aldi logo.svg",
  url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Aldi_logo.svg",
  source: "wikimedia-commons",
  author: "Logo artist",
  licensing: licensingFromDeclaration(
    "CC BY 4.0",
    "https://creativecommons.org/licenses/by/4.0/",
    "Data",
  ),
  pageUrl: "https://commons.wikimedia.org/wiki/File:Aldi_logo.svg",
  contributors: [
    {
      sourceId: "wikimedia-commons",
      name: "Wikimedia Commons",
      url: "https://commons.wikimedia.org/wiki/File:Aldi_logo.svg",
    },
  ],
};
describe("BrandLogo", () => {
  beforeEach(() => {
    logo.data = credited;
  });
  it("defers a filename-only logo until complete file metadata exists", () => {
    logo.data = undefined;
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    expect(screen.queryByRole("img", { name: "Aldi" })).toBeNull();
  });
  it("keeps the artist, Commons file and licence visible beside the image", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    expect(screen.getByText("Logo artist", { exact: false })).toBeVisible();
    expect(screen.getByRole("link", { name: "CC-BY-4.0" })).toHaveAttribute(
      "href",
      credited.licensing?.bindings[0].license.url,
    );
    expect(screen.getByRole("link", { name: "Wikimedia Commons" })).toHaveAttribute(
      "href",
      credited.pageUrl,
    );
  });
  it("renders a proxied Commons URL when the brand has a logo", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    const img = screen.getByRole("img", { name: "Aldi" });
    expect(img.getAttribute("src")).toContain("/api/image-proxy?url=");
    expect(decodeURIComponent(img.getAttribute("src") ?? "")).toContain("Aldi_logo.svg");
  });

  it("never points the browser directly at Commons", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    const src = screen.getByRole("img", { name: "Aldi" }).getAttribute("src") ?? "";
    expect(src.startsWith("https://commons.wikimedia.org")).toBe(false);
  });

  it("falls back to the preset icon when the brand has no logo", () => {
    const { container } = render(
      <BrandLogo brand={{ qid: "Q1", name: "Nameless", kind: ["brand"] }} />,
    );
    expect(screen.queryByRole("img", { name: "Nameless" })).toBeNull();
    expect(container.firstChild).not.toBeNull();
  });

  it("falls back to the preset icon when the logo image fails to load", () => {
    render(
      <BrandLogo brand={{ qid: "Q1", name: "Aldi", kind: ["brand"], logoFile: "Aldi logo.svg" }} />,
    );
    const img = screen.getByRole("img", { name: "Aldi" });
    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "Aldi" })).toBeNull();
  });
});

it("credits the selected catalogue filename only while its licensed bytes are displayed", () => {
  logo.data = credited;
  const selected = { sourceId: "name-suggestion-index", name: "Captured filename selection" };
  const hidden = { sourceId: "hidden-name", name: "Undisplayed catalogue label" };
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <BrandLogo
        brand={{
          qid: "Q1",
          name: "Aldi",
          kind: ["brand"],
          logoFile: credited.logoFile,
          contributors: [selected, hidden],
          fieldContributors: { logoFile: [selected], name: [hidden] },
        }}
      />
    </NextIntlClientProvider>,
  );
  expect(screen.getByText("Captured filename selection")).toBeVisible();
  expect(screen.queryByText("Undisplayed catalogue label")).toBeNull();
  fireEvent.error(screen.getByRole("img", { name: "Aldi" }));
  expect(screen.queryByText("Captured filename selection")).toBeNull();
  expect(screen.queryByText("Logo artist", { exact: false })).toBeNull();
});
