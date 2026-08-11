import { useCategorySearchStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrandHeaderCard } from "../BrandHeaderCard";

// useBrandDetail is the only source of `website` — stub it per test so the
// javascript: URL regression test doesn't depend on a live query resolving.
const mockUseBrandDetail = vi.fn();
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useBrandDetail: () => mockUseBrandDetail(),
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
});
