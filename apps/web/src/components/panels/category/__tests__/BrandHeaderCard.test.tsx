import { useCategorySearchStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      <BrandHeaderCard />
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

  it("renders author and licence once the attribution query resolves", () => {
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
        author: "Jane Doe",
        authorUrl: "https://commons.wikimedia.org/wiki/User:JaneDoe",
        license: "CC BY-SA 4.0",
        licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
      },
    });

    renderCard();

    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("CC BY-SA 4.0")).toBeInTheDocument();
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
