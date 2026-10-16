import { useCategorySearchStore } from "@openmapx/core";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../../../../packages/i18n/locales/en.json";
import { BrandHeaderCard } from "../BrandHeaderCard";

// useBrandDetail is the only source of `website` — stub it per test so the
// javascript: URL regression test doesn't depend on a live query resolving.
const mockUseBrandDetail = vi.fn();
// useBrandLogoAttribution resolves lazily and must not block name/description
// rendering — stub it per test so attribution tests don't depend on a real
// network fetch, and capture the call args to assert it stays disabled when
// the brand has no logo to attribute.
const mockUseBrandLogoAttribution = vi.fn();
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useBrandDetail: () => mockUseBrandDetail(),
    useBrandLogoAttribution: (qid: string | null, hasLogo: boolean) =>
      mockUseBrandLogoAttribution(qid, hasLogo),
  };
});

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en}>
        <BrandHeaderCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("BrandHeaderCard", () => {
  beforeEach(() => {
    useCategorySearchStore.getState().clearCategory();
    mockUseBrandDetail.mockReturnValue({ data: undefined });
    mockUseBrandLogoAttribution.mockReturnValue({ data: undefined });
  });

  it("renders nothing when no brand is active", () => {
    const { container } = renderCard();
    expect(container.firstChild).toBeNull();
  });

  it("shows the brand name and description from the store", () => {
    useCategorySearchStore
      .getState()
      .setBrandFilter(
        { qid: "Q41171", name: "Aldi", kind: ["brand"], description: "German supermarket chain" },
        { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
      );
    renderCard();
    expect(screen.getByText("Aldi")).toBeInTheDocument();
    expect(screen.getByText("German supermarket chain")).toBeInTheDocument();
  });

  it("does not render a link for a javascript: website", () => {
    useCategorySearchStore
      .getState()
      .setBrandFilter(
        { qid: "Q41171", name: "Aldi", kind: ["brand"], description: "German supermarket chain" },
        { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
      );
    mockUseBrandDetail.mockReturnValue({ data: { website: "javascript:alert(1)" } });

    renderCard();

    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Aldi website")).not.toBeInTheDocument();
  });

  // The attribution URLs are the least trusted input this card renders:
  // `licenseUrl` is a Commons `extmetadata` value and `authorUrl` is parsed out
  // of the `Artist` HTML blob. The repo-wide href gate allowlists binding names
  // rather than tracking sanitization, so once `authorUrl`/`licenseUrl` are
  // listed there it can no longer tell whether they are still wrapped in
  // `safeHref` — these assertions are what actually holds that guarantee.
  it("does not render links for javascript: attribution URLs", () => {
    useCategorySearchStore.getState().setBrandFilter(
      {
        qid: "Q41171",
        name: "Aldi",
        kind: ["brand"],
        description: "German supermarket chain",
        logoFile: "Aldi Nord Logo.svg",
      },
      { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
    );
    mockUseBrandDetail.mockReturnValue({ data: undefined });
    mockUseBrandLogoAttribution.mockReturnValue({
      data: {
        author: "Some Author",
        authorUrl: "javascript:alert(1)",
        licensing: licensingFromDeclaration("CC BY-SA 4.0", "javascript:alert(2)"),
      },
    });

    renderCard();

    // Unsafe/incomplete licence metadata cannot authorize logo bytes or a guessed credit.
    expect(screen.queryByRole("img", { name: "Aldi" })).toBeNull();
    expect(screen.queryByText(/Some Author/)).toBeNull();
    expect(screen.queryByText(/CC BY-SA 4\.0/)).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders name and description immediately, before attribution resolves", () => {
    useCategorySearchStore.getState().setBrandFilter(
      {
        qid: "Q41171",
        name: "Aldi",
        kind: ["brand"],
        description: "German supermarket chain",
        logoFile: "Aldi Nord Logo.svg",
      },
      { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
    );
    mockUseBrandLogoAttribution.mockReturnValue({ data: undefined });

    renderCard();

    expect(screen.getByText("Aldi")).toBeInTheDocument();
    expect(screen.getByText("German supermarket chain")).toBeInTheDocument();
  });

  it("renders resolved file credits below the heading instead of in the logo column", () => {
    useCategorySearchStore.getState().setBrandFilter(
      {
        qid: "Q41171",
        name: "Aldi",
        kind: ["brand"],
        logoFile: "Aldi Nord Logo.svg",
      },
      { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
    );
    mockUseBrandLogoAttribution.mockReturnValue({
      data: {
        logoFile: "Aldi Nord Logo.svg",
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Aldi_Nord_Logo.svg",
        source: "wikimedia-commons",
        pageUrl: "https://commons.wikimedia.org/wiki/File:Aldi_Nord_Logo.svg",
        author: "Jane Doe",
        authorUrl: "https://commons.wikimedia.org/wiki/User:JaneDoe",
        licensing: licensingFromDeclaration(
          "CC BY-SA 4.0",
          "https://creativecommons.org/licenses/by-sa/4.0/",
        ),
      },
    });

    renderCard();

    expect(screen.getByRole("img", { name: "Aldi" }).parentElement?.textContent).toBe("");
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("CC-BY-SA-4.0")).toBeInTheDocument();
  });

  it("degrades silently when the attribution fetch has nothing to show", () => {
    useCategorySearchStore
      .getState()
      .setBrandFilter(
        { qid: "Q41171", name: "Aldi", kind: ["brand"], logoFile: "Aldi Nord Logo.svg" },
        { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
      );
    mockUseBrandLogoAttribution.mockReturnValue({ data: undefined });

    renderCard();

    expect(screen.getByText("Aldi")).toBeInTheDocument();
  });

  it("only enables the attribution query when the brand has a logo to attribute", () => {
    useCategorySearchStore
      .getState()
      .setBrandFilter(
        { qid: "Q41171", name: "Aldi", kind: ["brand"] },
        { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
      );

    renderCard();

    expect(mockUseBrandLogoAttribution).toHaveBeenCalledWith("Q41171", false);
  });
});

it("credits retained catalogue fields without a logo and excludes hidden logo selection", () => {
  const label = {
    sourceId: "label-source",
    name: "Selected label source",
    url: "https://label.example",
  };
  const description = {
    sourceId: "description-source",
    name: "Selected description source",
    url: "https://description.example",
  };
  const website = {
    sourceId: "website-source",
    name: "Selected website source",
    url: "https://website.example",
  };
  const hidden = { sourceId: "hidden-logo", name: "Hidden logo selection" };
  useCategorySearchStore.getState().setBrandFilter(
    {
      qid: "Q1",
      name: "Retained Brand",
      kind: ["brand"],
      description: "Retained description",
      contributors: [label, description, hidden],
      fieldContributors: { name: [label], description: [description], logoFile: [hidden] },
    },
    { selectors: [] },
  );
  mockUseBrandDetail.mockReturnValue({
    data: {
      website: "https://brand.example",
      contributors: [website],
      fieldContributors: { website: [website] },
    },
  });
  mockUseBrandLogoAttribution.mockReturnValue({ data: undefined });
  renderCard();
  expect(screen.getByRole("link", { name: "Selected label source" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Selected description source" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Selected website source" })).toBeVisible();
  expect(screen.queryByText("Hidden logo selection")).toBeNull();
});
